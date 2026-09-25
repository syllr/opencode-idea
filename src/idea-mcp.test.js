import { describe, expect, it } from 'vitest';
import { MCP_STREAM_PATH, serverConfig } from './idea-mcp.js';

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
});
