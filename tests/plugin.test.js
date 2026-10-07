// Integration tests for the plugin entry.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const openCalls = vi.hoisted(() => []);
// The platform the mocked launcher pretends to run on. Tests that need a
// platform without a launcher set this to e.g. 'win32'; afterEach restores it.
const launcher = vi.hoisted(() => ({ platform: 'darwin' }));
vi.mock('../src/ide-launcher.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Only macOS has `open -a`. Everywhere else no app resolves, and the
    // command asks the user to open the IDE by hand.
    autoLaunchSupported: () => launcher.platform === 'darwin',
    resolveIdeApp: (value) =>
      launcher.platform === 'darwin' ? actual.resolveIdeApp(value) : undefined,
    openInIde: async (...args) => {
      openCalls.push(args);
      return true;
    },
  };
});

import plugin, { ideFeedback } from '../src/plugin.js';
import { startFakeIde } from './helpers/fake-ide.js';

const projectPath = mkdtempSync(path.join(tmpdir(), 'ojbm-'));

afterAll(() => rmSync(projectPath, { recursive: true, force: true }));

let running;
afterEach(async () => {
  openCalls.length = 0;
  launcher.platform = 'darwin';
  if (running) {
    await new Promise((resolve) => running.close(resolve));
    running = undefined;
  }
});

/**
 * Start a fake IDE whose single project IS the test project, so the serving
 * branch resolves it and skips the redundant `open -a`.
 */
async function startFakeIdeForProject(port) {
  const fake = await startFakeIde(port);
  fake.setProjectOpen(projectPath, true);
  return fake;
}

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
  const {
    toolsReadyAfter = 1,
    directory = projectPath,
    // What the IDE's MCP catalog exposes. Overridable so a test can pin what
    // "the IDE is serving" means without depending on tool names.
    ideaTools = ['idea_read_file', 'idea_apply_patch', 'idea_create_new_file'],
    ...ctxOptions
  } = options;
  const state = {
    mcp: 0,
    mcpReload: 0,
    toolReload: 0,
    toolList: 0,
    toolsReadyAfter,
    tools: [],
    sessionHook: undefined,
    sessionHooks: {},
    toolHook: undefined,
    commands: new Map(),
    skills: new Map(),
    prompts: [],
    storage: new Map(),
    storageGets: 0,
    mcpServers: [],
    mcpConfig: undefined,
    mcpDisposed: 0,
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
          state.tools = ideaTools.map((id) => ({ id }));
        },
        hook: async (name, callback) => {
          state.toolHook = callback;
          return { dispose: () => {} };
        },
      },
      mcp: {
        transform: async (callback) => {
          state.mcp += 1;
          // Simulate OpenCode registering the server and reaching `connected`.
          callback({
            set: (name, config) => {
              state.mcpConfig = { name, config };
              state.mcpServers = [{ name, status: { status: 'connected' } }];
            },
          });
          return {
            dispose: () => {
              state.mcpDisposed += 1;
            },
          };
        },
        reload: async () => {
          state.mcpReload += 1;
        },
        list: async () => ({ data: state.mcpServers }),
      },
      shell: {
        hook: async (name, callback) => {
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
          const added = [];
          callback({
            add: (definition) => {
              state.skills.set(definition.id, definition);
              added.push(definition.id);
            },
          });
          return {
            dispose: () => {
              for (const id of added) state.skills.delete(id);
            },
          };
        },
      },
      session: {
        hook: async (name, callback) => {
          state.sessionHooks[name] = callback;
          // `sessionHook` stays the context hook for the existing assertions.
          if (name === 'context') state.sessionHook = callback;
          return { dispose: () => {} };
        },
        prompt: async (input) => {
          state.prompts.push(input);
        },
      },
      storage: {
        get: async (key) => {
          state.storageGets += 1;
          return state.storage.get(key);
        },
        set: async (key, value) => {
          state.storage.set(key, value);
        },
        remove: async (key) => {
          state.storage.delete(key);
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

  it('registers the commands without touching the IDE', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    // Unmarked project: no IDE connection until `/open-in-idea` runs.
    expect(state.mcp).toBe(0);
    expect(state.commands.has('open-in-idea')).toBe(true);
    expect(state.commands.has('close-in-idea')).toBe(true);

    await cleanup();
  });

  it('leaves an unmarked project untouched', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'no-idea-'));
    const { ctx, state } = fakeCtx({ directory: plain });
    const cleanup = await plugin.setup(ctx);

    // Never marked, so no per-request prompt may mention IDEA. Nothing probes,
    // ever: the plugin only reacts to the request it sees.
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

  it('opens the project even when the IDE MCP endpoint is already serving', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The fake IDE answers `get_project_modules` with a real result, which means
    // the project WAS resolved — so it must NOT be opened again. This is the
    // regression the probe exists for: a redundant `open -a` makes the IDE run a
    // short reopen-then-dispose cycle.
    expect(openCalls).toHaveLength(0);
    expect(state.prompts[0].metadata.displayText).toContain('IDE MCP 已连接');

    await cleanup();
  });

  it('opens the project when the IDE is up but the project is not open', async () => {
    const fake = await startFakeIde();
    fake.setProjectOpen(false);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The IDE reports "cannot determine the target project", so the command must
    // ask the running instance to open THIS project.
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][0]).toBe(projectPath);
    expect(state.prompts[0].metadata.displayText).toContain('IDE MCP 已连接');

    await cleanup();
  });

  it('does not ask to open the project while serving when launching is disabled', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], openInIde: false, toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // `openInIde: false` still connects to an already-running endpoint, but must
    // never ask the OS to open the project.
    expect(openCalls).toHaveLength(0);
    expect(state.mcp).toBe(1);

    await cleanup();
  });

  it('asks the user to open the IDE on a platform without a launcher', async () => {
    launcher.platform = 'win32';
    const { ctx, state } = fakeCtx({
      ports: [await freePort()],
      mcpProbeTimeoutMs: 200,
      toolRefreshTimeoutMs: 100,
    });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // Nothing to launch and nothing to connect to. The notice must point at the
    // manual path, and nothing may claim the IDE was opened.
    expect(openCalls).toHaveLength(0);
    expect(state.mcp).toBe(0);
    expect(state.prompts[0].metadata.displayText).toContain('当前系统不支持自动打开 IDE');

    await cleanup();
  });

  it('connects on a platform without a launcher when the user opened the IDE by hand', async () => {
    launcher.platform = 'win32';
    const port = await freePort();
    running = (await startFakeIdeForProject(port)).server;
    const { ctx, state } = fakeCtx({ ports: [port], mcpProbeTimeoutMs: 200, toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The whole point of the manual flow: a hand-opened IDE connects exactly as
    // it does on macOS, and the plugin never tries to open it itself.
    expect(state.mcp).toBe(1);
    expect(openCalls).toHaveLength(0);

    await cleanup();
  });

  it('registers the IDE MCP as the remote Streamable-HTTP server by default', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolsReadyAfter: 3 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.mcpConfig.name).toBe('idea');
    expect(state.mcpConfig.config.type).toBe('remote');
    expect(state.mcpConfig.config.url).toContain(`:${fake.port}/stream`);
    expect(state.mcpConfig.config.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe(projectPath);
    expect(state.mcpConfig.config.codemode).toBe(false);
    // 10-minute cap by default, so a wedged server fails in finite time instead
    // of OpenCode's 12h default.
    expect(state.mcpConfig.config.timeout).toEqual({ execution: 600000 });

    await cleanup();
  });

  it('honours an executionTimeoutMs override', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolsReadyAfter: 3, executionTimeoutMs: 45000 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.mcpConfig.config.timeout).toEqual({ execution: 45000 });

    await cleanup();
  });

  it('rebuilds the server when /open-in-idea is run again', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);
    const command = state.commands.get('open-in-idea');

    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const transformsAfterFirst = state.mcp;
    const disposedAfterFirst = state.mcpDisposed;

    await command.execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The second run tears the old registration down (which is what kills the
    // bridge child) and registers a fresh one, so a zombie can never survive a
    // re-run of /open-in-idea.
    expect(state.mcp).toBe(transformsAfterFirst + 1);
    expect(state.mcpDisposed).toBeGreaterThan(disposedAfterFirst);
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

    // Unmarked project: no IDEA prompt at all. Guidance waits for /open-in-idea.
    const before = [];
    await state.sessionHook({ system: before });
    expect(before).toHaveLength(0);

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
    // a whole, and data sources are created/edited by the user in the IDE.
    expect(request.tools).not.toHaveProperty('idea_git_status');
    expect(request.tools).not.toHaveProperty('idea_execute_tool');
    expect(request.tools).not.toHaveProperty('idea_xdebug_get_stack');
    expect(request.tools).not.toHaveProperty('idea_recognize_ij_module_kind');
    expect(request.tools).not.toHaveProperty('idea_generate_psi_tree');
    expect(request.tools).not.toHaveProperty('idea_get_python_environment');
    expect(request.tools).not.toHaveProperty('idea_get_repositories');
    expect(request.tools).not.toHaveProperty('idea_create_database_connection');
    expect(request.tools).toHaveProperty('idea_read_file');

    // The IDE terminal IS exposed: project commands (java / python / npm) must
    // run with the SDKs the user configured in the IDE, so the model uses the
    // IDE's integrated terminal instead of the native shell.
    expect(request.tools).toHaveProperty('idea_execute_terminal_command');

    await cleanup();
  });

  it('injects recovery guidance only for marked projects', async () => {
    // Unmarked: no IDEA prompt at all.
    const off = fakeCtx();
    const cleanupOff = await plugin.setup(off.ctx);
    const systemOff = [];
    await off.state.sessionHook({ system: systemOff });
    expect(systemOff).toHaveLength(0);
    await cleanupOff();

    // Marked in an earlier run, no IDE: the fast-fail recovery hint stays.
    const marked = fakeCtx();
    marked.state.storage.set(`project/${projectPath}`, true);
    const cleanupMarked = await plugin.setup(marked.ctx);
    const systemMarked = [];
    await marked.state.sessionHook({ system: systemMarked });
    expect(systemMarked).toHaveLength(1);
    expect(systemMarked[0].text).toContain('IDEA MCP failure recovery');
    await cleanupMarked();

    // Marked, guidance injection disabled: the recovery hint still goes out.
    const disabled = fakeCtx({ injectGuidance: false });
    disabled.state.storage.set(`project/${projectPath}`, true);
    const cleanupDisabled = await plugin.setup(disabled.ctx);
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

    // Unmarked and IDE not open yet: no IDEA prompt is present.
    const before = [];
    await state.sessionHook({ system: before });
    expect(before).toHaveLength(0);

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

    // Not serving after serving: OpenCode's registry has already dropped the IDEA
    // tools, so a request that carries none IS the "the bridge is gone" case —
    // and it can happen while the IDE endpoint still answers. The plugin stops
    // promising tools the model cannot call and heals off the request snapshot.
    const gone = { system: [], tools: { read: {} } };
    await state.sessionHook(gone);
    expect(gone.system).toHaveLength(1);
    expect(gone.system[0].text).toContain('IDEA MCP failure recovery');
    // The reconnecting variant, not "retry the operation once": a call made in
    // this request can only fail with `No tool named ... available`.
    expect(gone.system[0].text).toContain('Do NOT call any idea_* tool');
    expect(state.mcpReload).toBe(1);

    // The latch is what makes the next message reconnect. Missing it is exactly
    // what left the session dead until the user ran `/open-in-idea` by hand.
    await state.sessionHooks.prompt({ sessionID: 's1', prompt: { text: '继续' } });
    expect(state.mcpReload).toBe(2);

    await cleanup();
  });

  it('reconnects and rewrites a dropped IDEA tool error mid-turn', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.toolHook).toBeTypeOf('function');
    const mcpAfterCommand = state.mcp;

    // The IDE MCP drops mid-turn: no connected server, its tools gone.
    state.mcpServers = [];
    state.tools = [];

    const event = {
      tool: 'idea_apply_patch',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);

    // Reconnected, tools reloaded, and the error now tells the model to retry.
    expect(state.mcp).toBe(mcpAfterCommand + 1);
    expect(event.error.message).toContain('已重新连接');
  });

  it('reconnects on the transport failure OpenCode actually reports (measured)', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const afterOpen = state.mcp;

    // Measured against OpenCode 2.0.19 with the IDE process killed. None of the
    // older markers (`MCP server "idea" is not available` / `Error POSTing to
    // endpoint`) appeared; the client reported its own connect failure, which
    // used to classify as `none` — so a dead IDE silently never healed.
    const byMessage = {
      tool: 'idea_get_project_modules',
      sessionID: 's1',
      status: 'error',
      error: { message: 'Unable to connect. Is the computer able to access the url?' },
    };
    await state.toolHook(byMessage);
    expect(state.mcp).toBe(afterOpen + 1);
    expect(byMessage.error.message).toContain('已重新连接');

    // The same failure expressed structurally rather than by text.
    const byCode = {
      tool: 'idea_get_project_modules',
      sessionID: 's1',
      status: 'error',
      error: { message: 'something else entirely', error: { code: 'ConnectionRefused' } },
    };
    await state.toolHook(byCode);
    expect(state.mcp).toBe(afterOpen + 2);
    expect(byCode.error.message).toContain('已重新连接');

    await cleanup();
  });

  it('never reconnects on a business error while the server is connected', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;

    // The server still reports connected, so a failed call is a business error
    // (e.g. a bad path), not a dropped connection: leave it untouched.
    const event = {
      tool: 'idea_apply_patch',
      sessionID: 's1',
      status: 'error',
      error: { message: 'File not found: src/missing.kt' },
    };
    await state.toolHook(event);

    expect(state.mcp).toBe(mcpAfterCommand);
    expect(event.error.message).toBe('File not found: src/missing.kt');

    await cleanup();
  });

  it('does not treat tool output that merely mentions a refused connection as a drop', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;

    // The message of an MCP tool error is the tool's own content, so a query
    // against a stopped database reads exactly like a transport failure.
    const event = {
      tool: 'idea_execute_sql_query',
      sessionID: 's1',
      status: 'error',
      error: { message: 'java.net.ConnectException: Connection refused' },
    };
    await state.toolHook(event);

    expect(state.mcp).toBe(mcpAfterCommand);
    expect(event.error.message).toBe('java.net.ConnectException: Connection refused');

    await cleanup();
  });

  it('still registers the remote transport when launching is disabled', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolsReadyAfter: 3, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // `openInIde: false` disables auto-launch; it must not change how the IDE
    // MCP server is registered.
    expect(state.mcpConfig.config.type).toBe('remote');
    expect(state.mcpConfig.config.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe(projectPath);

    await cleanup();
  });

  it('ignores tool errors in an unmarked project or for non-IDEA tools', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    state.mcpServers = [];
    state.tools = [];

    // Unmarked project: the plugin stays out of the way.
    const unmarked = { tool: 'idea_read_file', sessionID: 's1', status: 'error', error: { message: 'boom' } };
    await state.toolHook(unmarked);
    expect(state.mcp).toBe(0);
    expect(unmarked.error.message).toBe('boom');

    // Marked project, but the failed tool is not an IDEA tool.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;
    state.mcpServers = [];
    const foreign = { tool: 'edit', sessionID: 's1', status: 'error', error: { message: 'boom' } };
    await state.toolHook(foreign);
    expect(state.mcp).toBe(mcpAfterCommand);
    expect(foreign.error.message).toBe('boom');

    await cleanup();
  });

  it('leaves the error untouched when the mid-turn reconnect fails', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    state.mcpServers = [];
    state.tools = [];

    const event = {
      tool: 'idea_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);

    // No reconnect: the recovery guidance still explains the manual fallback.
    expect(event.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('keeps a dropped IDE down on later requests until /open-in-idea re-registers it', async () => {
    const port = await freePort();
    const fake = await startFakeIde(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcp).toBe(1);

    // The connection drops: OpenCode's registry drops the IDEA tools. The
    // `context` hook is a pure function of the request and never re-registers
    // anything behind the user's back; only the `prompt` and `tool` hooks
    // auto-recover, for a marked project (covered separately).
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

  it('reopens the project when the IDE is up but the project is not open', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The IDE reports "project not open" in two shapes; both must reopen it.
    // Real text captured from IDEA 2026.2.3 (see the B-scenario probe).
    const variants = [
      'Unable to determine the target project for the current MCP tool call.',
      "`projectPath`=`/p` doesn't correspond to any open project.",
    ];
    for (const message of variants) {
      openCalls.length = 0;
      const event = { tool: 'idea_read_file', sessionID: 's1', status: 'error', error: { message } };
      await state.toolHook(event);

      expect(openCalls.length).toBeGreaterThan(0);
      expect(event.error.message).toContain('重新打开');
    }

    await cleanup();
  });

  it('does not claim to reopen a project on a platform without a launcher', async () => {
    launcher.platform = 'win32';
    // IDE running, but THIS project is not open in it.
    running = (await startFakeIde()).server;
    const { ctx, state } = fakeCtx({ ports: [running.address().port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcp).toBe(1);

    openCalls.length = 0;
    const message = 'Unable to determine the target project for the current MCP tool call.';
    const event = { tool: 'idea_read_file', sessionID: 's1', status: 'error', error: { message } };
    await state.toolHook(event);

    // With no launcher there is nothing to call, so the plugin must NOT report
    // the project as reopened — that would send the model round after round
    // after a call that can never succeed. Leave the IDE's own error alone: it
    // names the real cause, and the user opens the project by hand.
    expect(openCalls).toHaveLength(0);
    expect(event.error.message).toBe(message);

    await cleanup();
  });

  it('does not reconnect for an unmarked project or a non-IDEA tool', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    // Unmarked project: the plugin stays out of the way even on a connection error.
    const unmarked = {
      tool: 'idea_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(unmarked);
    expect(state.mcp).toBe(0);
    expect(unmarked.error.message).toBe('MCP server "idea" is not available');

    // Marked project, but the failed tool is not an IDEA tool.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;
    const foreign = {
      tool: 'edit',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(foreign);
    expect(state.mcp).toBe(mcpAfterCommand);
    expect(foreign.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('leaves the error untouched when the reconnect cannot reach the IDE', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const event = {
      tool: 'idea_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);

    // No reconnect happened, so the original error stays.
    expect(event.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('marks the project even when the command cannot reach the IDE', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    // The mark means "this is an IDEA project", so it is set as soon as the
    // user asks, whether or not the IDE was reachable this time.
    expect(state.storage.get(`project/${projectPath}`)).toBe(true);

    await cleanup();
  });

  it('does not auto-register from a persisted mark at setup', async () => {
    const port = await freePort();
    const fake = await startFakeIde(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    // Marked in a previous run, before OpenCode restarted.
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    // setup reads the mark (for skills) but does not connect by itself; the MCP
    // is registered by `/open-in-idea` (or on a classified tool failure).
    expect(state.mcp).toBe(0);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.mcp).toBe(1);

    await cleanup();
  });

  it('close-in-idea unregisters the IDE MCP and clears the mark', async () => {
    const port = await freePort();
    const fake = await startFakeIde(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.storage.get(`project/${projectPath}`)).toBe(true);
    const disposedBefore = state.mcpDisposed;

    await state.commands.get('close-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.storage.has(`project/${projectPath}`)).toBe(false);
    expect(state.mcpDisposed).toBeGreaterThan(disposedBefore);
    expect(state.prompts.at(-1).metadata.displayText).toContain('已注销 IDE MCP 并清除项目标记');

    // Unmarked: a later connection failure is left alone.
    const mcpAfterClose = state.mcp;
    const event = {
      tool: 'idea_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);
    expect(state.mcp).toBe(mcpAfterClose);
    expect(event.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('registers context, prompt and tool hooks', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    expect(state.sessionHooks.context).toBeTypeOf('function');
    expect(state.sessionHooks.prompt).toBeTypeOf('function');
    expect(state.toolHook).toBeTypeOf('function');

    await cleanup();
  });

  it('resolves the project mark once and keeps it in sync on writes', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    // setup resolves the mark once; the tool hook reuses the cache.
    expect(state.storageGets).toBe(1);
    const ok = { tool: 'idea_read_file', sessionID: 's1', status: 'completed' };
    await state.toolHook(ok);
    expect(state.storageGets).toBe(1);

    // The command writes through: the next failed call still needs no storage read.
    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    const err = { tool: 'idea_read_file', sessionID: 's1', status: 'error', error: { message: 'File not found' } };
    await state.toolHook(err);
    expect(state.storageGets).toBe(1);

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

  it('registers the run-configuration skill for a project marked in an earlier run', async () => {
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    const skill = state.skills.get('idea-run-config');
    expect(skill).toBeTruthy();
    expect(skill.description).toContain('run configuration');
    expect(skill.content).toContain('.run/');
    expect(skill.content).toContain('idea_get_run_configurations');

    await cleanup();
  });

  it('registers the standalone-mode skill for a project marked in an earlier run', async () => {
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    // Every shipped skill follows the project mark, so the standalone rule
    // generator is available wherever the run-config skill is.
    expect(state.skills.has('idea-standalone')).toBe(true);
    expect(state.skills.get('idea-standalone').content).toContain('.opencode/rules/');

    await cleanup();
  });

  it('registers the run-configuration skill when /open-in-idea marks the project', async () => {
    const { ctx, state } = fakeCtx({ openInIde: false });
    const cleanup = await plugin.setup(ctx);
    expect(state.skills.size).toBe(0);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    expect(state.skills.get('idea-run-config')).toBeTruthy();

    await cleanup();
  });

  it('removes the run-configuration skill when /close-in-idea clears the mark', async () => {
    const { ctx, state } = fakeCtx({ openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.skills.has('idea-run-config')).toBe(true);

    await state.commands.get('close-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    expect(state.skills.has('idea-run-config')).toBe(false);

    await cleanup();
  });

  it('skips the run-configuration skill for an unmarked project', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'ojbm-bare-'));
    const { ctx, state } = fakeCtx({ directory: bare });
    const cleanup = await plugin.setup(ctx);

    expect(state.skills.size).toBe(0);

    await cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  it('schedules no background timer', async () => {
    // Recovery is request-driven only. No polling means no `setInterval` at all,
    // which is also what keeps the IDE log free of per-probe warnings.
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { ctx } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await cleanup();
  });

  it('heals on the next real user message when the instance has no registration', async () => {
    // The eviction scenario: OpenCode disposed the Location's services (LayerMap
    // idleTimeToLive = 60 minutes) and this is the fresh plugin instance. The
    // project is still marked, but setup deliberately does not connect.
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 50, mcpProbeTimeoutMs: 10 });
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    expect(state.mcp).toBe(0);

    // A plugin notice must NOT connect, or recovery would feed on itself...
    await state.sessionHooks.prompt({
      sessionID: 's1',
      prompt: { text: '【插件通知】IDE MCP 已连接' },
      metadata: { displayText: 'IDE MCP 已连接' },
    });
    expect(state.mcp).toBe(0);

    // ...but a real user message must. OpenCode awaits `prompt` before the
    // request is built, so the message itself already carries the tools.
    await state.sessionHooks.prompt({
      sessionID: 's1',
      prompt: { text: '继续' },
      metadata: { displayText: '继续' },
    });
    expect(state.mcp).toBeGreaterThan(0);
    expect(state.mcpConfig.config.type).toBe('remote');

    // A later message is a cheap no-op: the instance has a registration again.
    const afterHeal = state.mcp;
    await state.sessionHooks.prompt({ sessionID: 's1', prompt: { text: '再继续' } });
    expect(state.mcp).toBe(afterHeal);

    // And healing never launches the IDE on its own.
    expect(openCalls.length).toBe(0);

    await cleanup();
  });

  it('does not pin readiness to specific idea_* tool names', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    // The IDE can rename a tool, and the user can switch one off on the IDE's
    // Exposed Tools page. Readiness follows the `idea_` prefix, so whatever the
    // catalog actually exposes is what counts. With a fixed pair of names this
    // command ended in `tools-loading` ("工具列表尚未完成注册,请稍后再次执行
    // /open-in-idea") on every run, and re-running never helped.
    const { ctx, state } = fakeCtx({
      ports: [fake.port],
      toolRefreshTimeoutMs: 100,
      ideaTools: ['idea_read_file', 'idea_diagnostics'],
    });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });

    const feedback = state.prompts.map((entry) => entry?.text ?? '').join('\n');
    expect(feedback).toContain('IDE MCP 已连接');
    expect(feedback).not.toContain('尚未完成注册');

    await cleanup();
  });

  it('never launches the IDE while healing a marked project that was never opened', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 5 });
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    expect(state.mcp).toBe(0);

    // A message arrives, the mark says "IDEA project", but the endpoint is down.
    // The heal probes, finds nothing, and stops there: it must never `open -a`
    // on behalf of a project that was never opened.
    await state.sessionHooks.prompt({ sessionID: 's1', prompt: { text: 'hi' } });
    expect(state.mcp).toBe(0);
    expect(openCalls.length).toBe(0);

    await cleanup();
  });

  it('reconnects on the next message after a failed reconnect left no tools', async () => {
    const port = await freePort();
    const fake = await startFakeIde(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], mcpProbeTimeoutMs: 200, openInIde: false });
    state.storage.set(`project/${projectPath}`, true);
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    // The session is serving — remember it the way a real request would.
    await state.sessionHooks.context({ system: [], tools: { read: {}, idea_read_file: {} } });

    // The IDE goes away and an idea_* call fails. The failure path tries to
    // reconnect, but `reconcileOnce` tears the registration down FIRST and then
    // finds no port, so it stops there: no tools and no latch. Nothing polls in
    // the background any more, so the drop would go unnoticed until a request
    // revealed it — which is what the `context` hook below stands in for.
    await new Promise((resolve) => fake.server.close(resolve));
    await state.toolHook({
      tool: 'idea_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    });
    const afterFailure = state.mcp;

    // A request now arrives with no idea_* tools at all. This is the state that
    // used to do nothing: the next message was a no-op, and the session stayed
    // dead until `/open-in-idea` was run by hand.
    await state.sessionHooks.context({ system: [], tools: { read: {} } });
    // Guard the setup itself: the session really was serving before the drop.
    expect(afterFailure).toBeGreaterThan(0);

    // The IDE comes back; the next message reconnects off that latch.
    const revived = await startFakeIde(port);
    running = revived.server;
    await state.sessionHooks.prompt({ sessionID: 's1', prompt: { text: '继续' } });
    expect(state.mcp).toBeGreaterThan(afterFailure);

    await cleanup();
  });

  it('reconnects on its own when a request arrives without the tools', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], mcpProbeTimeoutMs: 200, toolRefreshTimeoutMs: 200 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    // The session is serving...
    await state.sessionHooks.context({ system: [], tools: { read: {}, idea_read_file: {} } });
    const served = state.mcp;

    // ...and this request has no idea_* tool at all. No user message is involved:
    // waiting for one is the gap that left the session dead, because the `prompt`
    // hook for a message runs BEFORE the request that reveals the loss.
    await state.sessionHooks.context({ system: [], tools: { read: {} } });

    const deadline = Date.now() + 2000;
    while (state.mcp <= served && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state.mcp).toBeGreaterThan(served);

    await cleanup();
  });

  it('reconnects when a request arrives without the tools the previous one had', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    const { ctx, state } = fakeCtx({
      ports: [fake.port],
      mcpProbeTimeoutMs: 200,
      toolRefreshTimeoutMs: 200,
    });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-idea').execute({ sessionID: 's1', prompt: { text: '' }, delivery: 'steer' });
    // A request that carried the tools marks this session as serving.
    await state.sessionHooks.context({ system: [], tools: { read: {}, idea_read_file: {} } });
    const afterOpen = state.mcp;

    // The server dropped: OpenCode removed its tools from the registry while the
    // IDE endpoint keeps answering. A request that carries none is the honest
    // signal, and the `context` hook heals off it without waiting for a message.
    state.tools = [];
    await state.sessionHooks.context({ system: [], tools: { read: {} } });

    const deadline = Date.now() + 2000;
    while (state.mcp <= afterOpen && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state.mcp).toBeGreaterThan(afterOpen);
    // The reconnect republished the catalog.
    expect(state.tools.some((tool) => tool.id?.startsWith('idea_'))).toBe(true);

    await cleanup();
  });
});
