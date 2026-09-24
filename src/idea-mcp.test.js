import { describe, expect, it } from 'vitest';
import { parseSseBlock, serverConfig } from './idea-mcp.js';

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
