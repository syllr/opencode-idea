// Integration test for the plugin entry: with a JetBrains project and no
// reachable IDE, the plugin still injects the `.idea` project SDK env into the
// shell hook and does not register any IDE MCP server.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import plugin from '../src/plugin.js';

const projectPath = mkdtempSync(path.join(tmpdir(), 'ojbm-'));
mkdirSync(path.join(projectPath, '.idea'));
writeFileSync(
  path.join(projectPath, '.idea', 'demo.iml'),
  '<module><component name="NewModuleRootManager"><orderEntry type="jdk" jdkName="$PROJECT_DIR$/.venv" jdkType="Python SDK" /></component></module>',
);

afterAll(() => rmSync(projectPath, { recursive: true, force: true }));

function fakeCtx() {
  const state = { tool: 0, mcp: 0, shellHook: undefined };
  return {
    state,
    ctx: {
      location: { project: { directory: projectPath } },
      options: { ports: [1], pollMs: 100000 },
      tool: {
        transform: async () => {
          state.tool += 1;
          return { dispose: () => {} };
        },
      },
      mcp: {
        transform: async () => {
          state.mcp += 1;
          return { dispose: () => {} };
        },
        reload: async () => {},
      },
      shell: {
        hook: async (name, callback) => {
          state.shellHook = callback;
          return { dispose: () => {} };
        },
      },
    },
  };
}

describe('plugin setup', () => {
  it('injects .idea SDK env into shell and skips IDE registration when no IDE is reachable', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    expect(state.shellHook).toBeTypeOf('function');
    expect(state.tool).toBe(0);
    expect(state.mcp).toBe(0);

    const input = { env: { PATH: '/usr/bin' } };
    state.shellHook(input);
    expect(input.env.VIRTUAL_ENV).toBe(path.join(projectPath, '.venv'));
    expect(input.env.PATH.startsWith(path.join(projectPath, '.venv', 'bin'))).toBe(true);

    await cleanup();
  });
});
