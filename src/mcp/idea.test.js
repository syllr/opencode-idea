import { describe, expect, it, vi } from 'vitest';
import { MCP_STREAM_PATH, callTool, serverConfig } from './idea.js';

describe('serverConfig', () => {
  it('builds a remote Streamable-HTTP config scoped to the project', () => {
    expect(serverConfig(64342, '/project')).toEqual({
      type: 'remote',
      url: `http://127.0.0.1:64342${MCP_STREAM_PATH}`,
      headers: { IJ_MCP_SERVER_PROJECT_PATH: '/project' },
      codemode: false,
    });
  });

  it('exposes IDE tools directly instead of through Code Mode', () => {
    expect(serverConfig(64342, '/project').codemode).toBe(false);
  });

  it('carries the execution timeout so a hung server fails in finite time', () => {
    expect(serverConfig(1, '/p', { executionTimeoutMs: 600000 }).timeout).toEqual({ execution: 600000 });
  });

  it('omits the timeout when none is requested', () => {
    expect(serverConfig(1, '/p')).not.toHaveProperty('timeout');
  });
});

describe('callTool', () => {
  const json = (body, headers = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

  it('echoes the Mcp-Session-Id returned by initialize on tools/call', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'sess-1' });
      }
      return json({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } });
    });

    await expect(callTool(64342, '/project', 'get_project_modules', {}, { fetchImpl })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });

    // Two POSTs: initialize, then the call. The IDE's Streamable-HTTP endpoint
    // rejects the second with "Server not initialized" unless it carries the
    // session id the first returned (verified against IntelliJ IDEA 2026.2.3).
    expect(calls).toHaveLength(2);
    expect(calls[0].options.headers['Mcp-Session-Id']).toBeUndefined();
    expect(calls[1].options.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(calls[1].options.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe('/project');
  });

  it('still calls without a session header when the server is stateless', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    });

    await callTool(64342, '/project', 'get_project_modules', {}, { fetchImpl });

    expect(calls[1].options.headers['Mcp-Session-Id']).toBeUndefined();
  });
});
