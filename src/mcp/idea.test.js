import { describe, expect, it } from 'vitest';
import { MCP_STREAM_PATH, STDIO_ARG, serverConfig, stdioServerConfig } from './idea.js';

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

describe('stdioServerConfig', () => {
  it('builds a local config running the IDE launcher in stdio bridge mode', () => {
    expect(stdioServerConfig('/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', 64342, '/project')).toEqual({
      type: 'local',
      command: ['/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', STDIO_ARG],
      environment: {
        IJ_MCP_SERVER_PROJECT_PATH: '/project',
        IJ_MCP_SERVER_PORT: '64342',
      },
      codemode: false,
    });
  });

  it("uses the array `command` shape OpenCode's LocalConfig requires (no `args`)", () => {
    // OpenCode validates the config against `LocalConfig`, where `command` is a
    // string array holding executable + arguments, and there is no `args` field
    // (`packages/schema/src/mcp.ts`; `client.ts` destructures `[command, ...args]`).
    const config = stdioServerConfig('/bin/idea', 1, '/p');
    expect(Array.isArray(config.command)).toBe(true);
    expect(config.command).toEqual(['/bin/idea', STDIO_ARG]);
    expect(config).not.toHaveProperty('args');
  });

  it('carries the same project scoping as the remote config', () => {
    expect(stdioServerConfig('/bin/idea', 1, '/p').environment.IJ_MCP_SERVER_PROJECT_PATH).toBe('/p');
  });

  it('carries the execution timeout so a hung bridge fails in finite time', () => {
    const config = stdioServerConfig('/bin/idea', 1, '/p', { executionTimeoutMs: 600000 });
    expect(config.timeout).toEqual({ execution: 600000 });
  });

  it('omits the timeout when none is requested', () => {
    expect(stdioServerConfig('/bin/idea', 1, '/p')).not.toHaveProperty('timeout');
  });
});
