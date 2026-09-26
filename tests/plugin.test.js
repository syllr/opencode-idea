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
  const { toolsReadyAfter = 1, directory = projectPath, ...ctxOptions } = options;
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
    skills: new Map(),
    prompts: [],
  };
  return {
    state,
    ctx: {
      location: { project: { directory } },
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
      skill: {
        transform: async (callback) => {
          callback({ add: (definition) => state.skills.set(definition.id, definition) });
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

  it('leaves projects without an IDEA directory untouched', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'no-idea-'));
    const { ctx, state } = fakeCtx({ directory: plain });
    const cleanup = await plugin.setup(ctx);

    // No IDEA tool can ever exist here, so no per-request prompt may mention
    // them. Nothing probes, ever: the plugin only reacts to the request it sees.
    const system = [];
    await state.sessionHook({ system, tools: { read: {} } });
    expect(system).toHaveLength(0);

    await cleanup();
    rmSync(plain, { recursive: true, force: true });
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
      // A real request while the IDE is connected carries its IDEA tools.
      tools: { edit: {}, write: {}, patch: {}, shell: {}, idea_read_file: {} },
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

  it('never exposes the hidden IDEA tools, even while the IDE is connected', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const request = {
      system: [],
      tools: {
        idea_read_file: {},
        idea_git_status: {},
        idea_execute_tool: {},
        idea_execute_terminal_command: {},
        idea_xdebug_get_stack: {},
        idea_recognize_ij_module_kind: {},
        idea_generate_psi_tree: {},
        idea_get_python_environment: {},
        idea_get_repositories: {},
        idea_create_database_connection: {},
      },
    };
    await state.sessionHook(request);

    // Version control goes through the native tool, and the router dispatcher is
    // redundant while every routed tool is exposed directly. The Debugger, Dev
    // Kit MCP, Inspection KTS MCP and Python Environment MCP groups are hidden as
    // a whole, data sources are created/edited by the user in the IDE, and the
    // terminal tool is only needed by the plugin's own IDE-env read (which calls
    // the MCP endpoint directly, not through the model tool list).
    expect(request.tools).not.toHaveProperty('idea_git_status');
    expect(request.tools).not.toHaveProperty('idea_execute_tool');
    expect(request.tools).not.toHaveProperty('idea_xdebug_get_stack');
    expect(request.tools).not.toHaveProperty('idea_recognize_ij_module_kind');
    expect(request.tools).not.toHaveProperty('idea_generate_psi_tree');
    expect(request.tools).not.toHaveProperty('idea_get_python_environment');
    expect(request.tools).not.toHaveProperty('idea_get_repositories');
    expect(request.tools).not.toHaveProperty('idea_create_database_connection');
    expect(request.tools).not.toHaveProperty('idea_execute_terminal_command');
    expect(request.tools).toHaveProperty('idea_read_file');

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

    const after = { system: [], tools: { idea_read_file: {} } };
    await state.sessionHook(after);
    expect(after.system).toHaveLength(2);
    expect(after.system[1].text).toContain('必须使用');

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

  it('reads "the IDE is serving" from the request snapshot, not a probe', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcpReload).toBe(1);

    // Requests never touch the endpoint. The `context` hook fires for every
    // agent-loop step, so it is a pure function of the request: the snapshot
    // OpenCode hands it already says whether the IDEA tools are there.
    const probes = fake.streamRequests();
    const serving = { system: [], tools: { read: {}, idea_read_file: {}, idea_git_status: {} } };
    await state.sessionHook(serving);
    await state.sessionHook({ system: [], tools: { idea_read_file: {} } });
    expect(fake.streamRequests()).toBe(probes);

    // Serving: hidden tools are stripped, the rest survive, full guidance goes out.
    expect(serving.tools).toHaveProperty('idea_read_file');
    expect(serving.tools).not.toHaveProperty('idea_git_status');
    expect(serving.system).toHaveLength(2);
    expect(serving.system[1].text).toContain('必须使用');

    // Not serving: OpenCode's registry has already dropped the IDEA tools, so a
    // request that carries none IS the "IDE is gone" case. The plugin takes no
    // action of its own and stops promising tools the model cannot call.
    const gone = { system: [], tools: { read: {} } };
    await state.sessionHook(gone);
    expect(gone.system).toHaveLength(1);
    expect(gone.system[0].text).toContain('IDEA MCP failure recovery');
    expect(state.mcpReload).toBe(1);

    await cleanup();
  });

  it('never reacts to a failed IDEA tool call on its own', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // Reacting to a tool error is exactly what used to tear a healthy IDE down: a
    // business error ("File not found") or a single transport hiccup unregistered
    // everything. The plugin now installs no tool hook at all — only the manual
    // command and the server's own status events change anything.
    expect(state.toolHook).toBeUndefined();
    expect(state.mcpReload).toBe(1);
    expect(state.toolReload).toBe(1);

    const request = { system: [], tools: { read: {}, idea_read_file: {} } };
    await state.sessionHook(request);
    expect(request.tools).toHaveProperty('read');
    expect(request.tools).toHaveProperty('idea_read_file');
    expect(request.system).toHaveLength(2);
    expect(request.system[1].text).toContain('必须使用');

    await cleanup();
  });

  it('brings a dropped IDE back only through /open-in-idea', async () => {
    const port = await freePort();
    const fake = await startFakeIde(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcp).toBe(1);

    // The connection drops: OpenCode's registry drops the IDEA tools, and the
    // plugin takes no action — nothing is re-registered behind the user's back.
    state.tools = [];
    await state.sessionHook({ system: [], tools: {} });
    await state.sessionHook({ system: [], tools: {} });
    expect(state.mcp).toBe(1);

    // Only the manual command brings it back. The registry says the server is
    // gone, so the command replaces the registration instead of just refreshing
    // it — an unchanged config is never reconnected by OpenCode.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcp).toBe(2);
    expect(state.mcpReload).toBe(2);
    const request = { system: [], tools: { read: {}, idea_read_file: {} } };
    await state.sessionHook(request);
    expect(request.tools).toHaveProperty('idea_read_file');
    expect(request.system).toHaveLength(2);
    expect(request.system[1].text).toContain('必须使用');

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

  it('registers the run-configuration skill for JetBrains projects', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    const skill = state.skills.get('idea-run-config');
    expect(skill).toBeTruthy();
    expect(skill.description).toContain('run configuration');
    expect(skill.content).toContain('.run/');
    expect(skill.content).toContain('idea_get_run_configurations');

    await cleanup();
  });

  it('skips the run-configuration skill outside JetBrains projects', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'ojbm-bare-'));
    const { ctx, state } = fakeCtx({ directory: bare });
    const cleanup = await plugin.setup(ctx);

    expect(state.skills.size).toBe(0);

    await cleanup();
    rmSync(bare, { recursive: true, force: true });
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
