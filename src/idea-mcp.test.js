import { describe, expect, it } from 'vitest';
import { parseSseBlock, serverConfig, serverRequestResponse } from './idea-mcp.js';

describe('parseSseBlock', () => {
  it('parses an endpoint event', () => {
    expect(parseSseBlock('event: endpoint\ndata: /message?sessionId=abc')).toEqual({
      event: 'endpoint',
      data: '/message?sessionId=abc',
    });
  });

  it('defaults to the message event and joins multi-line data', () => {
    expect(parseSseBlock('data: line1\ndata: line2')).toEqual({ event: 'message', data: 'line1\nline2' });
  });
});

describe('serverConfig', () => {
  it('builds a remote SSE config scoped to the project', () => {
    expect(serverConfig(64342, '/project')).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:64342/sse',
      headers: { IJ_MCP_SERVER_PROJECT_PATH: '/project' },
    });
  });
});

describe('serverRequestResponse', () => {
  it('answers roots/list with the project root', () => {
    expect(serverRequestResponse({ method: 'roots/list', id: 'abc' }, '/project')).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      result: { roots: [{ uri: 'file:///project', name: 'project' }] },
    });
  });

  it('rejects unknown server requests', () => {
    expect(serverRequestResponse({ method: 'sampling/createMessage', id: 7 }, '/project')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found' },
    });
  });
});
