import { describe, expect, it, vi } from 'vitest';
import {
  callTool,
  MCP_STREAM_PATH,
  ideProjectPath,
  PROBE_DOWN,
  PROBE_NO_PROJECT,
  PROBE_OK,
  PROBE_BUSY,
  probeProject,
  serverConfig,
} from './idea.js';

describe('ideProjectPath', () => {
  it('normalizes a Windows path to the forward slashes the IDE matches', () => {
    // IDE 收的项目选择器是系统无关形式,所以 OpenCode 报的平台原生路径不能原样上线。
    expect(ideProjectPath('E:\\gitea\\secondev-demo')).toBe('E:/gitea/secondev-demo');
    expect(ideProjectPath('/Users/me/proj')).toBe('/Users/me/proj');
  });
});

describe('serverConfig', () => {
  it('builds a remote Streamable-HTTP config scoped to the project', () => {
    expect(serverConfig(64342, '/project')).toEqual({
      type: 'remote',
      url: `http://127.0.0.1:64342${MCP_STREAM_PATH}`,
      headers: { IJ_MCP_SERVER_PROJECT_PATH: '/project' },
      // IDE 工具直接暴露给模型,不走 Code Mode。
      codemode: false,
    });
  });

  it('sends a Windows project path in the form the IDE expects', () => {
    expect(serverConfig(64342, 'E:\\gitea\\secondev-demo').headers).toEqual({
      IJ_MCP_SERVER_PROJECT_PATH: 'E:/gitea/secondev-demo',
    });
  });

  it('carries the execution timeout so a hung server fails in finite time', () => {
    expect(serverConfig(1, '/p', { executionTimeoutMs: 600000 }).timeout).toEqual({ execution: 600000 });
    expect(serverConfig(1, '/p')).not.toHaveProperty('timeout');
  });
});

describe('callTool', () => {
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

  /** 一个假的 IDE 端点:第一次 initialize 带回 session id,之后正常应答。 */
  const fakeIde = ({ sessionId } = {}) => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'DELETE') return new Response(null, { status: 200 });
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: 1, result: {} }, sessionId ? { 'mcp-session-id': sessionId } : {});
      }
      return json({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } });
    });
    return { calls, fetchImpl };
  };

  it('echoes the Mcp-Session-Id returned by initialize on tools/call', async () => {
    const { calls, fetchImpl } = fakeIde({ sessionId: 'sess-1' });

    await expect(callTool(64342, '/project', 'get_project_modules', {}, { fetchImpl })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });

    // 两次 POST:先 initialize,再调用。IDE 的 Streamable-HTTP 端点会拿第二次
    // "Server not initialized" 拒掉,除非它带上第一次返回的 session id
    // (对着 IntelliJ IDEA 2026.2.3 实测过)。
    const posts = calls.filter((call) => call.options.method !== 'DELETE');
    expect(posts).toHaveLength(2);
    expect(posts[0].options.headers['Mcp-Session-Id']).toBeUndefined();
    expect(posts[1].options.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(posts[1].options.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe('/project');
    // 用完要 DELETE，否则 IDEA 侧会留 abandoned session。
    const close = calls.find((call) => call.options.method === 'DELETE');
    expect(close?.options.headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('surfaces HTTP / JSON-RPC errors instead of silently returning undefined', async () => {
    const httpError = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} });
      return new Response('nope', { status: 500 });
    });
    await expect(callTool(64342, '/project', 'get_project_env', {}, { fetchImpl: httpError }))
      .rejects.toThrow(/HTTP 500/);

    const rpcError = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} });
      return json({ jsonrpc: '2.0', id: 2, error: { message: 'tool not found' } });
    });
    await expect(callTool(64342, '/project', 'missing_tool', {}, { fetchImpl: rpcError }))
      .rejects.toThrow(/tool not found/);
  });

  it('still calls without a session header when the server is stateless', async () => {
    const { calls, fetchImpl } = fakeIde();
    await callTool(64342, '/project', 'get_project_modules', {}, { fetchImpl });
    expect(calls[1].options.headers['Mcp-Session-Id']).toBeUndefined();
  });

  it('asks about a Windows project with the same spelling it registered it under', async () => {
    const { calls, fetchImpl } = fakeIde();
    await callTool(64342, 'E:\\gitea\\secondev-demo', 'get_project_modules', {}, { fetchImpl });

    // 发的和注册的必须一致,否则插件用一种写法注册、又用另一种写法去问,永远匹配不上。
    const asked = calls[1].options.headers.IJ_MCP_SERVER_PROJECT_PATH;
    const registered = serverConfig(64342, 'E:\\gitea\\secondev-demo').headers.IJ_MCP_SERVER_PROJECT_PATH;
    expect(asked).toBe('E:/gitea/secondev-demo');
    expect(asked).toBe(registered);
  });
});

describe('probeProject', () => {
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

  /** 一个会正常应答的端点；`env` 决定 `get_project_env` 回什么。 */
  const servingIde = ({ env } = {}) => {
    const calls = [];
    const deletedSessions = [];
    const fetchImpl = vi.fn(async (url, options) => {
      if (options?.method === 'DELETE') {
        deletedSessions.push(options.headers?.['Mcp-Session-Id']);
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 's1' });
      }
      return json({
        jsonrpc: '2.0',
        id: 2,
        result: env ?? { structuredContent: { PATH: '/bin', variables: {}, projectPath: '/project' } },
      });
    });
    return { calls, deletedSessions, fetchImpl };
  };

  it('reports the project the IDE says it is serving', async () => {
    const { fetchImpl, deletedSessions } = servingIde();
    await expect(probeProject(64342, '/project', { fetchImpl })).resolves.toMatchObject({
      state: PROBE_OK,
      projectPath: '/project',
    });
    // 探测不是长期会话：确认真的把这条 session 关了，而不是只在 README 里写着。
    expect(deletedSessions).toEqual(['s1']);
  });

  it('separates "server answered, this project is not open" from "server is gone"', async () => {
    const { fetchImpl } = servingIde({
      env: {
        content: [{ type: 'text', text: 'Unable to determine the target project.' }],
        isError: true,
      },
    });
    await expect(probeProject(64342, '/project', { fetchImpl })).resolves.toMatchObject({
      state: PROBE_NO_PROJECT,
    });

    // 连不上是另一件事：调用方据此决定"拉起 IDE"，而不是"打开项目"。
    const refused = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    await expect(probeProject(64342, '/project', { fetchImpl: refused })).resolves.toMatchObject({
      state: PROBE_DOWN,
    });
  });

  it('calls a connection that never answers busy, not gone', async () => {
    // 端点接了连接但一直不答（IDE 卡住/索引中）。把它归成 down 会导致重复拉起。
    const hanging = vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await expect(
      probeProject(64342, '/project', { fetchImpl: hanging, initializeTimeoutMs: 20, callTimeoutMs: 20 }),
    ).resolves.toMatchObject({ state: PROBE_BUSY });
  });

  it('treats HTTP / JSON-RPC / unknown isError as busy, not down or no-project', async () => {
    const withCall = (callResult) => vi.fn(async (_url, options) => {
      if (options.method === 'DELETE') return new Response(null, { status: 200 });
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} });
      return callResult();
    });

    const httpError = withCall(() => new Response('nope', { status: 503 }));
    await expect(probeProject(64342, '/project', { fetchImpl: httpError }))
      .resolves.toMatchObject({ state: PROBE_BUSY });

    const rpcError = withCall(() => json({ jsonrpc: '2.0', id: 2, error: { message: 'busy' } }));
    await expect(probeProject(64342, '/project', { fetchImpl: rpcError }))
      .resolves.toMatchObject({ state: PROBE_BUSY });

    const unknownError = withCall(() => json({
      jsonrpc: '2.0',
      id: 2,
      result: { isError: true, content: [{ type: 'text', text: 'index is not ready' }] },
    }));
    await expect(probeProject(64342, '/project', { fetchImpl: unknownError }))
      .resolves.toMatchObject({ state: PROBE_BUSY });
  });

  it('gives the project call its own budget instead of the leftover from initialize', async () => {
    // 回归：两段曾共用一个 AbortController，于是 initialize 的短超时把 get_project_env
    // 也掐了 —— 冷启动的 IDE 因此永远被读成"这个项目没打开"。
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return json({
        jsonrpc: '2.0',
        id: 2,
        result: { structuredContent: { projectPath: '/project' } },
      });
    });

    await expect(
      probeProject(64342, '/project', { fetchImpl, initializeTimeoutMs: 20, callTimeoutMs: 400 }),
    ).resolves.toMatchObject({ state: PROBE_OK });
  });
});
