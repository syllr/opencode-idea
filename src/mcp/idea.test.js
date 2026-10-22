import { describe, expect, it, vi } from 'vitest';
import { MCP_STREAM_PATH, callTool, ideProjectPath, serverConfig } from './idea.js';

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
    expect(calls).toHaveLength(2);
    expect(calls[0].options.headers['Mcp-Session-Id']).toBeUndefined();
    expect(calls[1].options.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(calls[1].options.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe('/project');
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
