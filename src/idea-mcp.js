// JetBrains IDE MCP detection and probing.
//
// HOW THE IDE MCP SERVER WORKS (verified against a real IntelliJ IDEA MCP
// server; see the project README for the full findings):
//
//   * The IDE exposes one local MCP server (SSE transport) at
//     http://127.0.0.1:<port>/sse. The port is IDE/session specific.
//   * The project a call targets is selected by the HTTP header
//     `IJ_MCP_SERVER_PROJECT_PATH`.
//   * Connecting to /sse and calling `tools/list` does NOT tell you whether a
//     project is open: the server returns the same global IDE tool set for any
//     header value, including a garbage path.
//   * Only a real tool CALL does. Calling `get_project_modules` with the
//     project header succeeds when the project is open, and returns an MCP
//     error (listing the currently open projects) when it is not.
//
// IMPORTANT: the server sends a `roots/list` request back to the client (it
// asks for the workspace roots) before running many tools. A client that does
// not answer it hangs forever. This client answers `roots/list` with the
// project directory, mirroring what a real MCP client does.

import { pathToFileURL } from 'node:url';

export const PROJECT_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH';

/** OpenCode MCP server name registered for the IDE. */
export const IDEA_SERVER_NAME = 'idea';

/** Ports to try when the IDE MCP port is not configured explicitly. */
export const DEFAULT_PORTS = [64342, 6420, 6421, 63342];

const PROBE_TOOL = 'get_project_modules';
const PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the OpenCode MCP server config for a given IDE port + project.
 *
 * @param {number} port
 * @param {string} projectPath
 */
export function serverConfig(port, projectPath) {
  return {
    type: 'remote',
    url: `http://127.0.0.1:${port}/sse`,
    headers: { [PROJECT_HEADER]: projectPath },
  };
}

/**
 * Parse one SSE frame (the block between blank lines).
 *
 * @param {string} block
 * @returns {{ event: string, data: string }}
 */
export function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
  }
  return { event, data: data.join('\n') };
}

/**
 * Reply to a server -> client request. Only `roots/list` is expected; anything
 * else is rejected so the server does not wait forever.
 *
 * @param {{ method: string, id: unknown }} request
 * @param {string} projectPath
 * @returns {object}
 */
export function serverRequestResponse(request, projectPath) {
  if (request.method === 'roots/list') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { roots: [{ uri: pathToFileURL(projectPath).href, name: projectPath.split('/').pop() }] },
    };
  }
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
}

/**
 * Run one MCP tool against the IDE, returning the raw tool result (with
 * `isError`) or `undefined` on transport/connect failure.
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {string} name
 * @param {object} [args]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ isError?: boolean, content?: Array<{ type: string, text?: string }> } | undefined>}
 */
export async function callTool(port, projectPath, name, args = {}, fetchImpl = fetch) {
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const pending = new Map();
  try {
    const response = await fetchImpl(`${base}/sse`, {
      headers: { [PROJECT_HEADER]: projectPath, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return undefined;

    let messageEndpoint;
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });

    const post = (payload) =>
      fetchImpl(new URL(messageEndpoint, base).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROJECT_HEADER]: projectPath },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => undefined);
    const rpc = (payload) =>
      new Promise((resolve) => {
        pending.set(payload.id, resolve);
        void post(payload);
      });

    readSse(response.body, (event, data) => {
      if (event === 'endpoint') {
        messageEndpoint = data;
        markReady();
        return;
      }
      if (event !== 'message') return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        void post(serverRequestResponse(message, projectPath));
        return;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    });

    await Promise.race([ready, sleep(3000)]);
    if (!messageEndpoint) return undefined;

    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'opencode-jetbrains-mcp', version: '0.1.0' },
      },
    }).catch(() => undefined);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const call = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }).catch(() => undefined);

    if (!call || call.error) return undefined;
    return call.result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Probe a single IDE MCP port for `projectPath`.
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function probePort(port, projectPath, fetchImpl = fetch) {
  const result = await callTool(port, projectPath, PROBE_TOOL, {}, fetchImpl).catch(() => undefined);
  return Boolean(result && result.isError !== true);
}

/**
 * Find the first port whose IDE MCP server has `projectPath` open.
 * Returns the port, or `undefined` when none is available.
 *
 * @param {string} projectPath
 * @param {number[]} ports
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number | undefined>}
 */
export async function probeOpenProject(projectPath, ports, fetchImpl = fetch) {
  for (const port of ports) {
    const open = await probePort(port, projectPath, fetchImpl).catch(() => false);
    if (open) return port;
  }
  return undefined;
}

async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const { event, data } = parseSseBlock(block);
        onEvent(event, data);
      }
    }
  } catch {
    // aborted or connection closed — expected during teardown
  }
}
