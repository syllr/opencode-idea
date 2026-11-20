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
//   * Availability probe is TWO phases with their own budgets, because they
//     answer different questions: `initialize` asks "is the endpoint there?"
//     (cheap, must be answered fast) and `get_project_env` asks "is THIS project
//     open in it?" (touches the project model, legitimately slow while the IDE
//     indexes after a restart). One shared budget made the second phase inherit
//     whatever the first one left over, so a cold IDE looked like "this project
//     is not open" — see `probeProject`.
//   * The probe reports WHAT it saw (`ok` / `no-project` / `down` / `slow`), not
//     a boolean: the caller has to decide between waiting, opening the project,
//     and telling the user to enable MCP, and those are not the same failure.

export const PROJECT_HEADER = 'IJ_MCP_SERVER_PROJECT_PATH';

/**
 * 探测结论。四种状态对应三种完全不同的后续动作，所以不能用布尔。
 *
 * - `ok`：端点活着，而且打开的就是这个项目 → 可以注册；
 * - `no-project`：MCP 服务正常应答，但目标项目没打开 → `open -a <dir>` 有用；
 * - `down`：连不上/握手被拒（IDE 没开、MCP 服务没启用）→ 拉起 IDE 有用；
 * - `slow`：连上了但没在预算内答完（冷启动、索引中）→ **等**，不要重复拉起。
 */
export const PROBE_OK = 'ok';
export const PROBE_NO_PROJECT = 'no-project';
export const PROBE_DOWN = 'down';
export const PROBE_SLOW = 'slow';

/** `initialize` 的预算：只判"端点在不在"，异常端点必须在 2s 内暴露。 */
export const PROBE_INITIALIZE_TIMEOUT_MS = 2000;
/** `get_project_env` 的预算：它要碰项目模型，冷启动/索引期就是慢。 */
export const PROBE_CALL_TIMEOUT_MS = 15000;

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
 * by the caller (always `ide`). See
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
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] `timeoutMs: 0` 表示不设超时
 * @returns {Promise<{ isError?: boolean, content?: Array<{ type: string, text?: string }> } | undefined>}
 */
export async function callTool(port, projectPath, name, args = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  // remote_* 不设内部超时（用户明确要求卡住由自己取消）；0 / Infinity 表示不挂定时器。
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  // 整次调用（initialize + tools/call）共用一个预算：调用方给的是"这次工具调用最多
  // 等多久"，不是"每个 POST 等多久"。
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const remaining = () => (deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now()));
  const base = {fetchImpl, port, projectPath, timeoutMs: remaining()};
  const initialized = await postRequest(base, initializePayload());
  if (initialized.state) return undefined;
  const response = await postRequest(
    {...base, sessionId: sessionIdOf(initialized.response), timeoutMs: remaining()},
    callPayload(name, args),
  );
  if (response.state || !response.response.ok) return undefined;
  const message = await parseToolResponse(response.response);
  if (!message || message.error) return undefined;
  return message.result;
}

/**
 * 探测「这个 IDE 的 MCP 服务里，此刻打开着的是不是 `projectPath`」。
 *
 * 两段各有预算：`initialize` 只证明端点在（短），`get_project_env` 才回答项目问题
 * （长）。返回**结论**而不是布尔，调用方才能区分"等"、"开项目"、"拉起 IDE"。
 *
 * 永不抛错：任何失败都折算成一个 `state`。
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   initializeTimeoutMs?: number,
 *   callTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ state: string, projectPath?: string, detail?: string }>}
 */
export async function probeProject(port, projectPath, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const initialized = await postRequest({
    fetchImpl,
    port,
    projectPath,
    timeoutMs: options.initializeTimeoutMs ?? PROBE_INITIALIZE_TIMEOUT_MS,
  }, initializePayload());
  if (initialized.state) return {state: initialized.state};
  if (!initialized.response.ok) {
    return {state: PROBE_DOWN, detail: `initialize HTTP ${initialized.response.status}`};
  }
  const response = await postRequest({
    fetchImpl,
    port,
    projectPath,
    sessionId: sessionIdOf(initialized.response),
    timeoutMs: options.callTimeoutMs ?? PROBE_CALL_TIMEOUT_MS,
  }, callPayload('get_project_env', {}));
  if (response.state) return {state: response.state};
  if (!response.response.ok) {
    return {state: PROBE_DOWN, detail: `get_project_env HTTP ${response.response.status}`};
  }
  const message = await parseToolResponse(response.response);
  if (!message || message.error) return {state: PROBE_DOWN, detail: 'get_project_env JSON-RPC error'};
  const result = message.result;
  if (result?.isError === true) {
    // IDE 为"目标项目没打开"回的就是 isError（Unable to determine the target project）。
    return {state: PROBE_NO_PROJECT, detail: textOf(result)};
  }
  const payload = (result?.structuredContent && typeof result.structuredContent === 'object')
    ? result.structuredContent
    : textJsonOf(result);
  const reported = typeof payload?.projectPath === 'string' && payload.projectPath !== ''
    ? payload.projectPath
    : undefined;
  if (!reported) return {state: PROBE_NO_PROJECT, detail: 'no projectPath in get_project_env'};
  return {state: PROBE_OK, projectPath: reported};
}

/** `tools/call` 的 JSON-RPC 载荷。 */
function callPayload(name, args) {
  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

/** `initialize` 的 JSON-RPC 载荷。 */
function initializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'opencode-idea', version: '0.1.15' },
    },
  };
}

/** The session id `initialize` binds the rest of the exchange to. */
function sessionIdOf(response) {
  return response?.headers?.get?.('mcp-session-id') ?? undefined;
}

/**
 * 一次 POST，带自己的预算。返回 `{response}` 或 `{state}`：超时是 `slow`（端点可能
 * 在，只是没答完），其它传输错误是 `down`（连不上）。
 *
 * 预算按调用单独计算 —— 这正是原来的 bug：两次 POST 共用一个 AbortController，第二次
 * 只能吃第一次的剩饭。
 */
async function postRequest({fetchImpl, port, projectPath, sessionId, timeoutMs}, payload) {
  const controller = new AbortController();
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${MCP_STREAM_PATH}`, {
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
    return {response};
  } catch (error) {
    return {state: aborted(error) ? PROBE_SLOW : PROBE_DOWN};
  } finally {
    clearTimeout(timer);
  }
}

/** 这个异常是不是"我们自己掐断的"（超时），而不是对端拒绝。 */
function aborted(error) {
  return error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
}

/** 工具结果里的文本，用于把 IDE 的原话带进日志。 */
function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** 工具结果文本里的 JSON（IDE 把结构塞进 text 时用）。 */
function textJsonOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return undefined;
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
