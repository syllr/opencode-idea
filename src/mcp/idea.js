// JetBrains IDE MCP server: endpoint config and availability probe.
//
// HOW THE IDE MCP SERVER WORKS (verified against a real IntelliJ IDEA 2026.2
// server):
//
//   * The IDE exposes a local MCP server at the Streamable-HTTP endpoint
//     `http://127.0.0.1:<port>/stream` (IntelliJ 2026.2+). That is the only
//     transport this plugin supports. The IDE's `stdioMcpServer` bridge was
//     dropped: both transports die with the project's Location services, and the
//     HTTP one at least reports a dead endpoint as an ordinary tool error
//     (which the plugin then heals) instead of hanging silently.
//   * The project a call targets is selected by the project path, carried in the
//     HTTP header `IJ_MCP_SERVER_PROJECT_PATH` (see `serverConfig`).
//   * Availability probe: a single `initialize` POST to `/stream` succeeds when
//     the MCP server is up. We do NOT check whether a specific project is open —
//     the user triggers `/open-in-ide` for the project they want, so "server is
//     up" is the only thing worth knowing.

export const PROJECT_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH';

/**
 * The project path in the form the IDE matches against.
 *
 * The IDE takes the project selector in system-independent form (forward
 * slashes) — its own MCP client configuration ships
 * `IJ_MCP_SERVER_PROJECT_PATH: "E:/gitea/secondev-demo"`, even on Windows.
 * OpenCode's `location` is the platform-native path, so on Windows it carries
 * backslashes (`E:\gitea\secondev-demo`) that the IDE does not necessarily
 * match. Normalizing here keeps one spelling on the wire for BOTH senders
 * below; they must agree, or the plugin asks about the project with one path
 * and registers it with another and never matches. On macOS this is a no-op.
 *
 * @param {string} projectPath
 * @returns {string}
 */
export function ideProjectPath(projectPath) {
  return projectPath.replace(/\\/g, '/');
}

/** Streamable-HTTP endpoint exposed by the IDE MCP server (IntelliJ 2026.2+). */
export const MCP_STREAM_PATH = '/stream';

const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 15000;

/**
 * Build the OpenCode MCP server config for a given IDE port + project.
 *
 * `codemode: false` exposes the IDE tools directly on the provider tool list
 * (as `<server>_<tool>`) instead of routing them through Code Mode. Direct
 * exposure passes each tool's full schema to the model, so parameter names are
 * known without exploration. The rest of an MCP server's options are unchanged.
 *
 * The server NAME is not decided here: it is the project's tool prefix, chosen
 * by the caller (root -> `ide`, a subproject -> its directory name). See
 * `ide-projects.js` for why the prefix encodes the LEVEL, not the IDE product.
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {{ executionTimeoutMs?: number }} [options]
 */
export function serverConfig(port, projectPath, options = {}) {
  /** @type {Record<string, unknown>} */
  const config = {
    type: 'remote',
    url: `http://127.0.0.1:${port}${MCP_STREAM_PATH}`,
    headers: { [PROJECT_HEADER]: ideProjectPath(projectPath) },
    codemode: false,
  };
  return withExecutionTimeout(config, options);
}

/**
 * Attach OpenCode's per-server execution timeout to an MCP config.
 *
 * OpenCode defaults this to **12 hours**. A wedged IDE MCP server can accept the
 * POST and never answer it, so without a cap a call made after the IDE died
 * would sit unresolved for the whole default. A finite cap turns that hang into
 * an ordinary timeout error the plugin can classify and heal from.
 *
 * @param {Record<string, unknown>} config
 * @param {{ executionTimeoutMs?: number }} options
 */
function withExecutionTimeout(config, options) {
  if (typeof options.executionTimeoutMs === 'number') {
    return { ...config, timeout: { execution: options.executionTimeoutMs } };
  }
  return config;
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
  const post = (payload, sessionId) =>
    fetchImpl(`http://127.0.0.1:${port}${MCP_STREAM_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        [PROJECT_HEADER]: ideProjectPath(projectPath),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  try {
    const initialized = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'opencode-idea', version: '0.0.26' },
      },
    });
    // The IDE's Streamable-HTTP endpoint binds follow-up requests to the session
    // created by `initialize`: without echoing its `Mcp-Session-Id` header the
    // server rejects the call with "Bad Request: Server not initialized"
    // (verified against IntelliJ IDEA 2026.2.3).
    const sessionId = initialized.headers?.get?.('mcp-session-id') ?? undefined;
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      sessionId,
    );
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
