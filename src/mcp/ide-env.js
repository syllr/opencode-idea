// Reads the IDE terminal environment over MCP and extracts the SDK-related
// variables. The IDE terminal is the single source of truth for the environment
// the IDE actually runs with (version-managed Node, goenv Go, SDKMAN Java, ...).

import { callTool } from './idea.js';

/** SDK-related variables worth mirroring into OpenCode's shell environment. */
export const SDK_ENV_KEYS = [
  'JAVA_HOME',
  'JRE_HOME',
  'JDK_HOME',
  'VIRTUAL_ENV',
  'PYTHONPATH',
  'PYTHONHOME',
  'GOROOT',
  'GOPATH',
  'GOBIN',
  'NODE_PATH',
  'NVM_BIN',
  'NVM_DIR',
  'MAVEN_HOME',
  'M2_HOME',
  'GRADLE_HOME',
  'SDKMAN_DIR',
  'CONDA_PREFIX',
];

/**
 * Read SDK env from the IDE integrated terminal via `execute_terminal_command`.
 * Requires the IDE MCP to be reachable and Brave Mode enabled (else the IDE
 * waits for a confirmation and this returns `{}`).
 *
 * @param {number} port
 * @param {string} projectPath
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Record<string, string>>}
 */
export async function readIdeTerminalEnv(port, projectPath, fetchImpl = fetch) {
  const result = await callTool(
    port,
    projectPath,
    'execute_terminal_command',
    { command: 'printenv', executeInShell: true, timeout: 8000, maxLinesCount: 800 },
    { fetchImpl, timeoutMs: 15000 },
  ).catch(() => undefined);
  if (!result || result.isError) return {};
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return extractSdkEnv(parseCommandOutput(text));
}

/**
 * Parse the `execute_terminal_command` payload. It is JSON with a
 * `command_output` field; fall back to treating the text as raw env output.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseCommandOutput(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.command_output === 'string') return parsePrintenv(parsed.command_output);
  } catch {
    // not JSON — treat as raw printenv output
  }
  return parsePrintenv(text);
}

/**
 * Parse `KEY=VALUE` lines (printenv output) into an object.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parsePrintenv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(index + 1);
  }
  return env;
}

/**
 * Keep only the SDK-related variables.
 *
 * @param {Record<string, string>} env
 * @returns {Record<string, string>}
 */
export function extractSdkEnv(env) {
  const out = {};
  for (const key of SDK_ENV_KEYS) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}
