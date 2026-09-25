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
  const { toolsReadyAfter = 1, ...ctxOptions } = options;
  const state = {
    mcp: 0,
    mcpReload: 0,
    toolReload: 0,
    toolList: 0,
    toolsReadyAfter,
    tools: [],
    shellHook: undefined,
    sessionHook: undefined,
    toolHook: undefined,
    commands: new Map(),
    prompts: [],
  };
  return {
    state,
    ctx: {
      location: { project: { directory: projectPath } },
      options: { ports: [1], ...ctxOptions },
      tool: {
        list: async () => {
          state.toolList += 1;
          return state.toolList < state.toolsReadyAfter ? [] : state.tools;
        },
        reload: async () => {
          state.toolReload += 1;
          state.tools = [
            { id: 'idea_read_file' },
            { id: 'idea_apply_patch' },
            { id: 'idea_create_new_file' },
          ];
        },
        hook: async (name, callback) => {
          state.toolHook = callback;
          return { dispose: () => {} };
        },
      },
      mcp: {
        transform: async () => {
          state.mcp += 1;
          return { dispose: () => {} };
        },
        reload: async () => {
          state.mcpReload += 1;
        },
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
    expect(state.mcp).toBe(0);
    expect(state.commands.has('open-in-idea')).toBe(true);

    await cleanup();
  });

  it('does not connect to the IDE at setup (manual mode)', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    // Setup never connects to the IDE; the command does.
    expect(state.mcp).toBe(0);

    await cleanup();
  });

  it('connects the IDE and loads capabilities when /open-in-idea runs', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolsReadyAfter: 3 });
    const cleanup = await plugin.setup(ctx);

    const command = state.commands.get('open-in-idea');
    expect(command).toBeTypeOf('object');
    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.mcp).toBe(1);
    expect(state.mcpReload).toBe(1);
    expect(state.toolReload).toBe(1);
    expect(state.toolList).toBeGreaterThanOrEqual(3);

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

  it('refreshes the tool catalog when /open-in-idea is run again', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);
    const command = state.commands.get('open-in-idea');

    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.mcp).toBe(1);
    expect(state.mcpReload).toBe(2);
    expect(state.toolReload).toBe(2);
    expect(state.prompts).toHaveLength(2);
    expect(state.prompts.every((prompt) => prompt.metadata.displayText.includes('原生工具已注册'))).toBe(true);

    await cleanup();
  });

  it('does not claim connected before the direct IDEA tool catalog is ready', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);
    delete ctx.tool.list;

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].metadata.displayText).toContain('尚未完成注册');
    expect(state.prompts[0].metadata.displayText).not.toContain('原生工具已注册');

    await cleanup();
  });

  it('fast-fails with an actionable MCP/Brave Mode notice when no endpoint exists', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50 });
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

  it('injects direct IDEA-tool guidance while the IDE is available', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    expect(state.sessionHook).toBeTypeOf('function');

    // Recovery guidance is always present; the full IDE catalog waits for /open-in-idea.
    const before = [];
    await state.sessionHook({ system: before });
    expect(before).toHaveLength(1);
    expect(before[0].text).toContain('/open-in-idea');

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const request = {
      system: [],
      tools: { edit: {}, write: {}, patch: {}, shell: {} },
    };
    await state.sessionHook(request);
    const system = request.system;
    expect(system).toHaveLength(2);
    expect(system.every((part) => part.type === 'text')).toBe(true);
    expect(system[1].text).toContain('必须使用');
    expect(system[1].text).toContain(projectPath);
    expect(system[1].text).toContain('idea_apply_patch');
    expect(request.tools).toHaveProperty('edit');
    expect(request.tools).toHaveProperty('write');
    expect(request.tools).toHaveProperty('patch');
    expect(request.tools).toHaveProperty('shell');

    await cleanup();
  });

  it('does not inject guidance when the IDE is not available, or when disabled', async () => {
    const off = fakeCtx();
    const cleanupOff = await plugin.setup(off.ctx);
    const systemOff = [];
    await off.state.sessionHook({ system: systemOff });
    expect(systemOff).toHaveLength(1);
    expect(systemOff[0].text).toContain('IDEA MCP failure recovery');
    await cleanupOff();

    const fake = await startFakeIde();
    running = fake.server;
    const disabled = fakeCtx({ ports: [fake.port], injectGuidance: false });
    const cleanupDisabled = await plugin.setup(disabled.ctx);
    expect(disabled.state.sessionHook).toBeTypeOf('function');
    const systemDisabled = [];
    await disabled.state.sessionHook({ system: systemDisabled });
    expect(systemDisabled).toHaveLength(1);
    expect(systemDisabled[0].text).toContain('IDEA MCP failure recovery');
    await cleanupDisabled();
  });

  it('activates IDE guidance after /open-in-idea when the IDE opens later', async () => {
    const port = await freePort();
    const { ctx, state } = fakeCtx({ ports: [port] });
    const cleanup = await plugin.setup(ctx);

    // IDE not open yet: only fast-fail recovery guidance is present.
    const before = [];
    await state.sessionHook({ system: before });
    expect(before).toHaveLength(1);
    expect(before[0].text).toContain('/open-in-idea');

    // IDE opens now (same port the plugin probes).
    const fake = await startFakeIde(port);
    running = fake.server;

    // The manual command loads capabilities and activates the guidance.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const after = [];
    await state.sessionHook({ system: after });
    expect(after).toHaveLength(2);
    expect(after[1].text).toContain('必须使用');

    await cleanup();
  });

  it('waits for a cold IDE MCP endpoint after launching', async () => {
    const port = await freePort();
    const { ctx, state } = fakeCtx({ ports: [port], mcpStartTimeoutMs: 2000, mcpProbeTimeoutMs: 50 });
    const cleanup = await plugin.setup(ctx);

    const execution = state.commands.get('open-in-idea').execute({
      sessionID: 's1',
      prompt: { text: '' },
      delivery: 'steer',
    });

    // The endpoint appears only after `/open-in-idea` has already launched the
    // IDE, matching a cold IntelliJ start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fake = await startFakeIde(port);
    running = fake.server;

    await execution;
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].metadata.displayText).toContain('原生工具已注册');

    await cleanup();
  });

  it('unregisters IDEA tools when the manually activated IDE disappears', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcpReload).toBe(1);

    // The desktop client and the background service have separate lifetimes:
    // closing IDEA must not leave dead idea_* tools advertised.
    await new Promise((resolve) => fake.server.close(resolve));
    running = undefined;

    const request = {
      system: [],
      tools: { read: {}, idea_read_file: {}, idea_apply_patch: {} },
    };
    await state.sessionHook(request);

    expect(request.tools).toHaveProperty('read');
    expect(request.tools).not.toHaveProperty('idea_read_file');
    expect(request.tools).not.toHaveProperty('idea_apply_patch');
    expect(request.system).toHaveLength(1);
    expect(request.system[0].text).toContain('IDEA MCP failure recovery');

    // The next request no longer probes or injects full guidance.
    const next = { system: [], tools: { read: {} } };
    await state.sessionHook(next);
    expect(next.system).toHaveLength(1);
    expect(next.system[0].text).toContain('IDEA MCP failure recovery');

    await cleanup();
  });

  it('unregisters IDEA tools after a failed IDEA tool call', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.toolHook).toBeTypeOf('function');

    await state.toolHook({ tool: 'idea_read_file', status: 'error', error: { message: 'connect failed' } });
    expect(state.mcpReload).toBe(2);
    expect(state.toolReload).toBe(2);

    const request = { system: [], tools: { read: {}, idea_read_file: {} } };
    await state.sessionHook(request);
    expect(request.tools).toHaveProperty('read');
    expect(request.tools).not.toHaveProperty('idea_read_file');
    expect(request.system).toHaveLength(1);
    expect(request.system[0].text).toContain('IDEA MCP failure recovery');

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
