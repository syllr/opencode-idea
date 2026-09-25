// Integration tests for the plugin entry.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const openCalls = vi.hoisted(() => []);
vi.mock('../src/ide-launcher.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openInIde: async (...args) => {
      openCalls.push(args);
      return true;
    },
  };
});

import plugin, { ideFeedback } from '../src/plugin.js';
import { startFakeIde } from './helpers/fake-ide.js';

const projectPath = mkdtempSync(path.join(tmpdir(), 'ojbm-'));
mkdirSync(path.join(projectPath, '.idea'));

afterAll(() => rmSync(projectPath, { recursive: true, force: true }));

let running;
afterEach(async () => {
  openCalls.length = 0;
  if (running) {
    await new Promise((resolve) => running.close(resolve));
    running = undefined;
  }
});

/** Reserve a free localhost port (closed immediately, reused by the fake IDE). */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function fakeCtx(options = {}) {
  const state = { tool: 0, mcp: 0, shellHook: undefined, sessionHook: undefined, commands: new Map(), prompts: [] };
  return {
    state,
    ctx: {
      location: { project: { directory: projectPath } },
      options: { ports: [1], ...options },
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
      command: {
        transform: async (callback) => {
          callback({ add: (definition) => state.commands.set(definition.name, definition) });
          return { dispose: () => {} };
        },
      },
      session: {
        hook: async (name, callback) => {
          state.sessionHook = callback;
          return { dispose: () => {} };
        },
        prompt: async (input) => {
          state.prompts.push(input);
        },
      },
    },
  };
}

describe('plugin setup', () => {
  it('gives an actionable MCP/Brave Mode notice when the endpoint is unavailable', () => {
    const opened = ideFeedback({ status: 'mcp-unavailable', opened: true });
    const notOpened = ideFeedback({ status: 'mcp-unavailable', opened: false });
    expect(opened).toContain('Settings → MCP Server');
    expect(opened).toContain('Brave Mode');
    expect(opened).toContain('/open-in-idea');
    expect(notOpened).toContain('开启 MCP 服务');
    expect(notOpened).toContain('Brave Mode');
  });

  it('registers the shell hook + command without touching the IDE', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    expect(state.shellHook).toBeTypeOf('function');
    expect(state.tool).toBe(0);
    expect(state.mcp).toBe(0);
    expect(state.commands.has('open-in-idea')).toBe(true);

    await cleanup();
  });

  it('does not connect to the IDE at setup (manual mode): no MCP, no tool rewrite', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    // Setup never connects to the IDE; the command does.
    expect(state.tool).toBe(0);
    expect(state.mcp).toBe(0);

    await cleanup();
  });

  it('connects the IDE and loads capabilities when /open-in-idea runs', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    const command = state.commands.get('open-in-idea');
    expect(command).toBeTypeOf('object');
    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.tool).toBe(1);
    expect(state.mcp).toBe(1);

    // Default feedback is a clearly-labelled notification: the model sees the
    // instruction and only acknowledges; the user sees the clean notice.
    expect(state.prompts).toHaveLength(1);
    const prompt = state.prompts[0];
    expect(prompt.sessionID).toBe('s1');
    expect(prompt.text).toContain('【插件通知】');
    expect(prompt.text).toContain('请只回复"收到"');
    expect(prompt.metadata.displayText).toContain('IDE MCP 已连接');
    expect(Array.isArray(prompt.metadata.comments)).toBe(true);

    await cleanup();
  });

  it('fast-fails with an actionable MCP/Brave Mode notice when no endpoint exists', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10 });
    const cleanup = await plugin.setup(ctx);
    const started = Date.now();
    const execution = state.commands.get('open-in-idea').execute({
      sessionID: 's1',
      prompt: { text: '' },
      delivery: 'steer',
    });

    // The command must notify and finish without a startup polling window.
    await vi.waitFor(() => expect(state.prompts).toHaveLength(1), { timeout: 300 });
    expect(openCalls).toHaveLength(1);
    expect(state.prompts[0].metadata.displayText).toContain('Brave Mode');

    await execution;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(state.prompts).toHaveLength(1);
    await cleanup();
  });

  it('injects IDE-tool guidance into the system prompt while the IDE is available', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    expect(state.sessionHook).toBeTypeOf('function');

    // Manual: guidance only appears once /open-in-idea has connected the IDE.
    const before = [];
    state.sessionHook({ system: before });
    expect(before).toHaveLength(0);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const system = [];
    state.sessionHook({ system });
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');
    expect(system[0].text).toContain('默认走 IDE MCP');
    expect(system[0].text).toContain('idea_apply_patch');

    await cleanup();
  });

  it('does not inject guidance when the IDE is not available, or when disabled', async () => {
    const off = fakeCtx();
    const cleanupOff = await plugin.setup(off.ctx);
    const systemOff = [];
    off.state.sessionHook({ system: systemOff });
    expect(systemOff).toHaveLength(0);
    await cleanupOff();

    const fake = await startFakeIde();
    running = fake.server;
    const disabled = fakeCtx({ ports: [fake.port], injectGuidance: false });
    const cleanupDisabled = await plugin.setup(disabled.ctx);
    expect(disabled.state.sessionHook).toBeUndefined();
    await cleanupDisabled();
  });

  it('activates IDE guidance after /open-in-idea when the IDE opens later', async () => {
    const port = await freePort();
    const { ctx, state } = fakeCtx({ ports: [port] });
    const cleanup = await plugin.setup(ctx);

    // IDE not open yet: no guidance.
    const before = [];
    state.sessionHook({ system: before });
    expect(before).toHaveLength(0);

    // IDE opens now (same port the plugin probes).
    const fake = await startFakeIde(port);
    running = fake.server;

    // The manual command loads capabilities and activates the guidance.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const after = [];
    state.sessionHook({ system: after });
    expect(after).toHaveLength(1);
    expect(after[0].text).toContain('默认走 IDE MCP');

    await cleanup();
  });

  it('does not launch the IDE when openInIde is false', async () => {
    const { ctx, state } = fakeCtx({ openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].metadata.displayText).toContain('已通过 openInIde: false 关闭');

    await cleanup();
  });

  it('is silent when feedback is false', async () => {
    const { ctx, state } = fakeCtx({ openInIde: false, feedback: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.prompts).toHaveLength(0);

    await cleanup();
  });

  it('never schedules periodic work (no timers) in manual mode', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { ctx } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    expect(spy).not.toHaveBeenCalled();
    await cleanup();
    spy.mockRestore();
  });
});
