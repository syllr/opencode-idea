// JetBrains IDE MCP server: endpoint config and availability probe.
//
// HOW THE IDE MCP SERVER WORKS (verified against a real IntelliJ IDEA 2026.2
// server):
//
//   * The IDE exposes a local MCP server. IntelliJ 2026.2+ exposes the modern
//     Streamable-HTTP endpoint at `http://127.0.0.1:<port>/stream`; older builds
//     only had the legacy SSE endpoint at `/sse`.
//   * OpenCode V2's remote MCP client speaks ONLY Streamable HTTP, so the plugin
//     registers `/stream` (see `serverConfig`). The legacy `/sse` endpoint is
//     unusable from OpenCode (POST returns 405 → "Error POSTing to endpoint").
//   * The project a call targets is selected by the HTTP header
//     `IJ_MCP_SERVER_PROJECT_PATH`.
//   * Availability probe: a single `initialize` POST to `/stream` succeeds when
//     the MCP server is up. We do NOT check whether a specific project is open —
//     the user triggers `/open-in-idea` for the project they want, so "server is
//     up" is the only thing worth knowing.

export const PROJECT_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH';

/** OpenCode MCP server name registered for the IDE. */
export const IDEA_SERVER_NAME = 'idea';

/** Streamable-HTTP endpoint exposed by the IDE MCP server (IntelliJ 2026.2+). */
export const MCP_STREAM_PATH = '/stream';

/** Ports to try when the IDE MCP port is not configured explicitly. */
export const DEFAULT_PORTS = [64342, 6420, 6421, 63342];

const PROTOCOL_VERSION = '2025-06-18';
// A probe is only a local availability check. Keep it short: a disabled IDE
// MCP endpoint must not make the user wait for the launch timeout before the
// actionable notification is sent.
const PROBE_TIMEOUT_MS = 1000;
const CALL_TIMEOUT_MS = 15000;

/**
 * Build the OpenCode MCP server config for a given IDE port + project.
 *
 * `codemode: false` exposes the IDE tools directly on the provider tool list
 * (as `idea_<tool>`) instead of routing them through Code Mode. Direct exposure
 * passes each tool's full schema to the model, so parameter names are known
 * without exploration. The rest of an MCP server's options are unchanged.
 *
 * @param {number} port
 * @param {string} projectPath
 */
export function serverConfig(port, projectPath) {
  return {
    type: 'remote',
    url: `http://127.0.0.1:${port}${MCP_STREAM_PATH}`,
    headers: { [PROJECT_HEADER]: projectPath },
    codemode: false,
  };
}

/**
 * Is an IDE MCP server listening on `port`? One Streamable-HTTP `initialize`
 * POST decides it: any 2xx JSON reply means the server is up.
 *
 * @param {number} port
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function probePort(port, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${MCP_STREAM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      // Do not follow redirects. IntelliJ can keep its normal HTTP port open
      // while MCP is disabled and redirect `/stream` to an HTML 404 page;
      // following that redirect only adds latency and still means unavailable.
      redirect: 'manual',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'opencode-idea', version: '0.0.5' },
        },
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Find the first port whose IDE MCP server responds. Returns the port, or
 * `undefined` when none is available.
 *
 * @param {number[]} ports
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<number | undefined>}
 */
export async function findIdePort(ports, options = {}) {
  // Probe all candidate ports concurrently. These are fallback locations for
  // one IDE MCP endpoint, not several active MCP servers. Sequential probes
  // multiply the timeout by the number of candidates and made a disabled MCP
  // look like a hang.
  const results = await Promise.all(
    ports.map(async (port) => [port, await probePort(port, options)]),
  );
  return results.find(([, available]) => available)?.[0];
}

/**
 * Call one MCP tool over the Streamable-HTTP endpoint. Returns the raw tool
 * result (with `isError`), or `undefined` on transport/connect failure.
 *
 * The IDE server answers each POST with a single JSON-RPC response (it does not
 * stream for these calls), so this is a plain request/response.
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {string} name
 * @param {object} [args]
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ isError?: boolean, content?: Array<{ type: string, text?: string }> } | undefined>}
 */
export async function callTool(port, projectPath, name, args = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CALL_TIMEOUT_MS);
  const post = (payload) =>
    fetchImpl(`http://127.0.0.1:${port}${MCP_STREAM_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [PROJECT_HEADER]: projectPath,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  try {
    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'opencode-idea', version: '0.0.5' },
      },
    });
    const response = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (!response.ok) return undefined;
    const message = await parseToolResponse(response);
    if (!message || message.error) return undefined;
    return message.result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Read a JSON-RPC reply that may arrive as plain JSON or as an SSE `message`. */
async function parseToolResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message.id === 2) return message;
    } catch {
      // ignore malformed frame
    }
  }
  return undefined;
}
