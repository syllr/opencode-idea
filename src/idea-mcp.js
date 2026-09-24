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
// So the probe is: open the SSE stream for the project, initialize, call
// get_project_modules, and check `result.isError`.

export const PROJECT_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH';

/** OpenCode MCP server name registered for the IDE. */
export const IDEA_SERVER_NAME = 'idea';

/** Ports to try when the IDE MCP port is not configured explicitly. */
export const DEFAULT_PORTS = [64342, 6420, 6421, 63342];

const PROBE_TOOL = 'get_project_modules';
const PROTOCOL_VERSION = '2024-11-05';
const PROBE_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 3000;

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

/**
 * Probe a single IDE MCP port for `projectPath`.
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function probePort(port, projectPath, fetchImpl = fetch) {
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const pending = new Map();
  try {
    const response = await fetchImpl(`${base}/sse`, {
      headers: { [PROJECT_HEADER]: projectPath, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return false;

    let messageEndpoint;
    let markReady;
    const ready = new Promise((resolve) => {
      markReady = resolve;
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
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    });

    await Promise.race([ready, sleep(HANDSHAKE_TIMEOUT_MS)]);
    if (!messageEndpoint) return false;

    const postUrl = new URL(messageEndpoint, base).toString();
    const post = (payload) =>
      fetchImpl(postUrl, {
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

    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'opencode-jetbrains-mcp', version: '0.1.0' },
      },
    }).catch(() => undefined);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const call = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: PROBE_TOOL, arguments: {} },
    }).catch(() => undefined);

    return Boolean(call && !call.error && call.result && call.result.isError !== true);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
