// Integration tests for the plugin entry.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const openCalls = vi.hoisted(() => []);
// The platform the mocked launcher pretends to run on. Tests that need a
// platform without a launcher set this to e.g. 'win32'; afterEach restores it.
const launcher = vi.hoisted(() => ({ platform: 'darwin', onOpen: null, installedIdes: ['idea'] }));
vi.mock('../src/ide-launcher.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Only macOS has `open -a`. Everywhere else no app resolves, and the
    // command asks the user to open the IDE by hand.
    autoLaunchSupported: () => launcher.platform === 'darwin',
    appNameFor: (app) => (launcher.platform === 'darwin' ? actual.appNameFor(app) : undefined),
    // 本机装了哪些 IDE:测试里固定成"只装了 IDEA",好断言提问文本里那句探测结论。
    detectInstalledIdes: () => launcher.installedIdes,
    openInIde: async (...args) => {
      openCalls.push(args);
      // A real `open -a` makes the IDE open the project, which is what the
      // "wait for THIS project to be served" loop is waiting for — so a test that
      // exercises that path has to simulate the project appearing.
      launcher.onOpen?.(args[0]);
      return true;
    },
  };
});

import plugin, { ideFeedback } from '../src/plugin.js';
import { IDE_PORTS } from '../src/ide-projects.js';
import { startFakeIde } from './helpers/fake-ide.js';

/** 端口是硬编码的固定值；测试会把 `IDE_PORTS` 指到假端口，用完必须还原。 */
const REAL_IDE_PORTS = { ...IDE_PORTS };

const projectPath = mkdtempSync(path.join(tmpdir(), 'ojbm-'));

/**
 * 一个已接入的配置：root 用某个 IDE，可选子项目。
 *
 * 旧版标记只是一个布尔 `true`；现在存的是结构化配置（见 `src/ide-projects.js`），
 * 所以每个需要"已接入"前提的测试都用它预置 storage。
 */
function ideConfig(rootPath, { app = 'idea', children = [] } = {}) {
  return { root: { path: rootPath, app }, children };
}

/**
 * What the IDE's bundled MCP server exposes — the catalog every supported IDE
 * serves. The companion plugin's tools are assumed present and are named by the
 * guidance unconditionally, so tests do not need to extend this for them.
 */
const DEFAULT_IDE_TOOLS = ['ide_read_file'];

/**
 * 部署 / 终端那两节的标题（模板里的字面量）。整节不再受 `{{#if}}` 控制，
 * "这一节在不在"只是结构断言，写在一处，改标题时不会漏。
 */
const DEPLOYMENT_HEADING = '### 服务器文件同步';

const TERMINAL_HEADING = '### 终端';

afterAll(() => rmSync(projectPath, { recursive: true, force: true }));

let running;
afterEach(async () => {
  openCalls.length = 0;
  launcher.platform = 'darwin';
  launcher.onOpen = null;
  launcher.installedIdes = ['idea'];
  IDE_PORTS.idea = REAL_IDE_PORTS.idea;
  IDE_PORTS.pycharm = REAL_IDE_PORTS.pycharm;
  if (running) {
    // Most tests run one fake IDE; multi-project tests run two.
    const servers = Array.isArray(running) ? running : [running];
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
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
    // 端口在生产代码里按 IDE 硬编码(`IDE_PORTS`),不开放配置;测试把假端口指进去,
    // 一个值就同时给 idea 与 pycharm,两个值则分别对应。
    ports,
    // What the IDE's MCP catalog exposes. Overridable so a test can pin what
    // "the IDE is serving" means without depending on tool names.
    ideaTools = DEFAULT_IDE_TOOLS,
    ...ctxOptions
  } = options;
  if (ports) {
    IDE_PORTS.idea = ports[0];
    IDE_PORTS.pycharm = ports[1] ?? ports[0];
  }
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
    toolHooks: {},
    toolDefinitions: {},
    commands: new Map(),
    skills: new Map(),
    prompts: [],
    storage: new Map(),
    storageGets: 0,
    mcpServers: [],
    mcpConfig: undefined,
    /** 每一次注册里 `set` 过的全部 server（多项目会一次 set 多个）。 */
    mcpConfigs: [],
    mcpDisposed: 0,
    /** 插件自己注册的工具（`configure_ide_project`）。 */
    registeredTools: {},
  };
  return {
    state,
    ctx: {
      location: { project: { directory } },
      options: { ...ctxOptions },
      tool: {
        list: async () => {
          state.toolList += 1;
          return state.toolList < state.toolsReadyAfter ? [] : state.tools;
        },
        reload: async () => {
          state.toolReload += 1;
          state.tools = ideaTools.map((id) => ({ id }));
        },
        transform: async (callback) => {
          callback({
            list: () => Object.keys(state.toolDefinitions).map((id) => ({ id })),
            get: (id) => {
              const definition = state.toolDefinitions[id];
              return definition ? { id, ...definition } : undefined;
            },
            add: (definition) => {
              if (definition && typeof definition.name === 'string') {
                state.registeredTools[definition.name] = definition;
              }
            },
            update: (id, update) => {
              const draft = { ...state.toolDefinitions[id] };
              update(draft);
              state.toolDefinitions[id] = draft;
            },
            remove: () => {},
          });
          return { dispose: () => {} };
        },
        hook: async (name, callback) => {
          state.toolHooks[name] = callback;
          // `toolHook` stays the `execute.after` hook for the existing assertions.
          if (name === 'execute.after') state.toolHook = callback;
          return { dispose: () => {} };
        },
      },
      mcp: {
        transform: async (callback) => {
          state.mcp += 1;
          state.mcpConfigs = [];
          // Simulate OpenCode registering the servers and reaching `connected`.
          callback({
            set: (name, config) => {
              state.mcpConfig = { name, config };
              state.mcpConfigs.push({ name, config });
              state.mcpServers = state.mcpConfigs.map((entry) => ({
                name: entry.name,
                status: { status: 'connected' },
              }));
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
    expect(opened).toContain('/open-in-ide');
    expect(notOpened).toContain('开启 MCP 服务');
    expect(notOpened).toContain('Brave Mode');
  });

  it('registers the commands and the skills without touching the IDE', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'no-idea-'));
    const { ctx, state } = fakeCtx({ directory: plain });
    const cleanup = await plugin.setup(ctx);

    // Manual mode: setup never connects. The command does.
    expect(state.mcp).toBe(0);
    expect(state.commands.has('open-in-ide')).toBe(true);
    expect(state.commands.has('delete-in-ide')).toBe(true);
    // The skills are static knowledge and go in as soon as the plugin loads.
    expect([...state.skills.keys()].sort()).toEqual(['idea-run-config-manager', 'idea-standalone']);

    // Never marked, so no per-request prompt may mention IDEA. Nothing probes,
    // ever: the plugin only reacts to the request it sees.
    const system = [];
    await state.sessionHook({ system, tools: { read: {} } });
    expect(system).toHaveLength(0);

    await cleanup();
    rmSync(plain, { recursive: true, force: true });
  });

  it('connects the IDE and loads capabilities when /open-in-ide runs', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolsReadyAfter: 3 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    expect(state.mcp).toBe(1);
    expect(state.mcpReload).toBe(1);
    expect(state.toolReload).toBe(1);
    expect(state.toolList).toBeGreaterThanOrEqual(3);

    // The IDE MCP is a remote Streamable-HTTP server, scoped to this project.
    expect(state.mcpConfig.name).toBe('ide');
    expect(state.mcpConfig.config.type).toBe('remote');
    expect(state.mcpConfig.config.url).toContain(`:${fake.port}/stream`);
    expect(state.mcpConfig.config.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe(projectPath);
    // IDE tools are exposed directly, not through Code Mode.
    expect(state.mcpConfig.config.codemode).toBe(false);
    // 10-minute cap by default, so a wedged server fails in finite time instead
    // of OpenCode's 12h default.
    expect(state.mcpConfig.config.timeout).toEqual({ execution: 600000 });

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

  it('opens the project only when the IDE does not already have it', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The fake IDE answers `get_project_modules` with a real result, which means
    // the project WAS resolved — so it must NOT be opened again. This is the
    // regression the probe exists for: a redundant `open -a` makes the IDE run a
    // short reopen-then-dispose cycle.
    expect(openCalls).toHaveLength(0);
    expect(state.prompts[0].metadata.displayText).toContain('IDE MCP 已连接');

    await cleanup();
  });

  it('asks the running IDE to open the project when it does not have it', async () => {
    const fake = await startFakeIdeForProject();
    fake.setProjectOpen(false);
    running = fake.server;
    // A real `open -a` ends with the project actually open, which is what the
    // "wait until THIS project is served" loop waits for.
    launcher.onOpen = () => fake.setProjectOpen(projectPath, true);
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The IDE reports "cannot determine the target project", so the command must
    // ask the running instance to open THIS project.
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][0]).toBe(projectPath);

    await cleanup();
  });

  it('connects but never launches when openInIde is false', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], openInIde: false, toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // `openInIde: false` still connects to an already-running endpoint, but must
    // never ask the OS to open the project.
    expect(openCalls).toHaveLength(0);
    expect(state.mcp).toBe(1);
    expect(state.prompts[0].metadata.displayText).toContain('IDE MCP 已连接');

    await cleanup();
  });

  it('on a platform without a launcher, asks the user — and connects what they opened', async () => {
    launcher.platform = 'win32';
    const port = await freePort();
    running = (await startFakeIdeForProject(port)).server;
    const { ctx, state } = fakeCtx({ ports: [port], mcpProbeTimeoutMs: 200, toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The whole point of the manual flow: a hand-opened IDE connects exactly as
    // it does on macOS, and the plugin never tries to open it itself.
    expect(state.mcp).toBe(1);
    expect(openCalls).toHaveLength(0);

    await cleanup();

    // Nothing to launch and nothing to connect to: the notice must point at the
    // manual path, and nothing may claim the IDE was opened.
    launcher.platform = 'win32';
    const offline = fakeCtx({ ports: [await freePort()], mcpProbeTimeoutMs: 200, toolRefreshTimeoutMs: 100 });
    const cleanupOffline = await plugin.setup(offline.ctx);
    await offline.state.commands
      .get('open-in-ide')
      .execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(offline.state.mcp).toBe(0);
    expect(offline.state.prompts[0].metadata.displayText).toContain('当前系统不支持自动打开 IDE');
    await cleanupOffline();
  });

  it('fast-fails with an actionable notice when no endpoint exists', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50 });
    const cleanup = await plugin.setup(ctx);
    const started = Date.now();
    const execution = state.commands.get('open-in-ide').execute({
      sessionID: 's1',
      prompt: { text: 'idea' },
      delivery: 'steer',
    });

    // The command must notify and finish without a startup polling window.
    await vi.waitFor(() => expect(state.prompts).toHaveLength(1), { timeout: 300 });
    expect(openCalls).toHaveLength(1);
    expect(state.prompts[0].metadata.displayText).toContain('Brave Mode');

    await execution;
    expect(Date.now() - started).toBeLessThan(1000);
    await cleanup();
  });

  it('does not claim connected before the IDEA tool catalog is ready', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    // The IDE can rename a tool, and the user can switch one off on the IDE's
    // Exposed Tools page. Readiness follows the `ide_` prefix, so whatever the
    // catalog actually exposes is what counts. With a fixed pair of names this
    // command ended in `tools-loading` on every run, and re-running never helped.
    const { ctx, state } = fakeCtx({
      ports: [fake.port],
      toolRefreshTimeoutMs: 100,
      ideaTools: ['ide_read_file', 'ide_diagnostics'],
    });
    const cleanup = await plugin.setup(ctx);
    delete ctx.tool.list;

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    const feedback = state.prompts.map((entry) => entry?.text ?? '').join('\n');
    expect(feedback).toContain('尚未完成注册');
    expect(feedback).not.toContain('并接入');

    await cleanup();
  });

  it('injects the guidance and strips the hidden tools from every request', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    const request = {
      system: [],
      tools: {
        edit: {},
        write: {},
        patch: {},
        shell: {},
        ide_read_file: {},
        ide_git_status: {},
        ide_execute_tool: {},
        ide_execute_terminal_command: {},
        ide_execute_run_configuration: {},
        ide_xdebug_get_stack: {},
        ide_recognize_ij_module_kind: {},
        ide_generate_psi_tree: {},
        ide_get_python_environment: {},
        ide_get_repositories: {},
        ide_create_database_connection: {},
        ide_execute_sql_query: {},
        ide_search_text: {},
        ide_apply_patch: {},
        ide_create_new_file: {},
      },
    };
    await state.sessionHook(request);

    const system = request.system;
    expect(system).toHaveLength(2);
    expect(system.every((part) => part.type === 'text')).toBe(true);
    expect(system[1].text).toContain(projectPath);
    expect(system[1].text).toContain('ide_search_symbol');
    // The native tools survive untouched.
    for (const name of ['edit', 'write', 'patch', 'shell']) {
      expect(request.tools).toHaveProperty(name);
    }

    // Version control goes through the native tool, and the router dispatcher is
    // redundant while every routed tool is exposed directly. The Debugger, Dev
    // Kit MCP, Inspection KTS MCP and Python Environment MCP groups are hidden as
    // a whole; the whole Database group is hidden; and plain file SEARCH with a
    // native equivalent is hidden too. Plain file WRITE is **kept** — writing
    // through the IDE is what keeps its in-memory copy and the file on disk the
    // same thing.
    for (const name of [
      'ide_git_status',
      'ide_execute_tool',
      'ide_xdebug_get_stack',
      'ide_recognize_ij_module_kind',
      'ide_generate_psi_tree',
      'ide_get_python_environment',
      'ide_get_repositories',
      'ide_create_database_connection',
      'ide_execute_sql_query',
      'ide_search_text',
      // `create_new_file` goes through the native `write`.
      'ide_create_new_file',
      // The IDE terminal does not inherit the project's environment, so it is no
      // better than the native shell.
      'ide_execute_terminal_command',
    ]) {
      expect(request.tools).not.toHaveProperty(name);
    }

    // Kept: `apply_patch` is the only multi-file writer on models that do not
    // get OpenCode's own `patch` tool (that one is GPT-only). Hiding it left
    // "same change across a dozen files" with no tool at all, and the model
    // answered that gap by writing a script that rewrites whole files.
    expect(request.tools).toHaveProperty('ide_apply_patch');
    // Kept: it is the only way to read inside a jar or the jrt:// image.
    expect(request.tools).toHaveProperty('ide_read_file');
    expect(request.tools).toHaveProperty('ide_execute_run_configuration');

    await cleanup();
  });

  it('never probes the endpoint from the request hook', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(state.mcpReload).toBe(1);

    // Requests never touch the endpoint. The `context` hook fires for every
    // agent-loop step, so it is a pure function of the request: the snapshot
    // OpenCode hands it already says whether the IDEA tools are there.
    const probes = fake.streamRequests();
    const serving = { system: [], tools: { read: {}, ide_read_file: {}, ide_git_status: {} } };
    await state.sessionHook(serving);
    await state.sessionHook({ system: [], tools: { ide_read_file: {} } });
    expect(fake.streamRequests()).toBe(probes);

    // Not serving after serving: OpenCode's registry has already dropped the IDEA
    // tools, so a request that carries none IS the "the bridge is gone" case —
    // and it can happen while the IDE endpoint still answers. The plugin stops
    // promising tools the model cannot call and heals off the request snapshot.
    const gone = { system: [], tools: { read: {} } };
    await state.sessionHook(gone);
    expect(gone.system).toHaveLength(1);
    expect(gone.system[0].text).toContain('IDE MCP failure recovery');
    // The reconnecting variant, not "retry the operation once": a call made in
    // this request can only fail with `No tool named ... available`.
    expect(gone.system[0].text).toContain('Do NOT call any of them now');
    expect(state.mcpReload).toBe(1);

    // The latch is what makes the next message reconnect. Missing it is exactly
    // what left the session dead until the user ran `/open-in-ide` by hand.
    await state.sessionHooks.prompt({ sessionID: 's1', prompt: { text: '继续' } });
    expect(state.mcpReload).toBe(2);

    await cleanup();
  });

  it('injects the recovery hint only for a marked project', async () => {
    // Unmarked: no IDEA prompt at all.
    const off = fakeCtx();
    const cleanupOff = await plugin.setup(off.ctx);
    const systemOff = [];
    await off.state.sessionHook({ system: systemOff });
    expect(systemOff).toHaveLength(0);
    await cleanupOff();

    // Marked in an earlier run, no IDE: the fast-fail recovery hint stays.
    const marked = fakeCtx();
    marked.state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanupMarked = await plugin.setup(marked.ctx);
    const systemMarked = [];
    await marked.state.sessionHook({ system: systemMarked });
    expect(systemMarked).toHaveLength(1);
    expect(systemMarked[0].text).toContain('IDE MCP failure recovery');
    await cleanupMarked();

    // Marked, guidance injection disabled: the recovery hint still goes out.
    const disabled = fakeCtx({ injectGuidance: false });
    disabled.state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanupDisabled = await plugin.setup(disabled.ctx);
    const systemDisabled = [];
    await disabled.state.sessionHook({ system: systemDisabled });
    expect(systemDisabled).toHaveLength(1);
    expect(systemDisabled[0].text).toContain('IDE MCP failure recovery');
    await cleanupDisabled();
  });

  it('always names the companion plugin tools once the IDE is serving', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The companion plugin `idea-mcp-enhance` is a hard prerequisite, so the
    // guidance names its tools unconditionally — no tool-presence check, even
    // when this request's snapshot looks like the bundled catalog only.
    const request = { system: [], tools: { read: {}, ide_read_file: {}, ide_build_project: {} } };
    await state.sessionHook(request);
    for (const name of [
      'ide_get_run_configurations',
      'ide_rerun_run_configuration',
      'ide_list_server_deployments',
      'ide_upload_to_deployment',
      'ide_project_sdk_terminal',
      'ide_terminal_read',
      'ide_terminal_interrupt',
      'ide_list_terminals',
      'ide_execute_in_remote_host',
    ]) {
      expect(request.system[1].text).toContain(name);
    }
    expect(request.system[1].text).toContain(DEPLOYMENT_HEADING);
    expect(request.system[1].text).toContain(TERMINAL_HEADING);

    await cleanup();
  });

  it('hides the owned build argument from the schema and forces it on every call', async () => {
    // A knob that is always overwritten must not also be advertised, or the
    // model sets it, reasons about it, and is wrong. The schema half and the
    // value half both come from FORCED_ARGUMENTS.
    const { ctx, state } = fakeCtx();
    // The prefix comes from the config (root = `ide_`), so a project has to be
    // connected first for the schema transform to have a target.
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    state.toolDefinitions.ide_build_project = {
      input: {
        type: 'object',
        properties: {
          rebuild: { type: 'boolean', description: 'Defaults to false.' },
          filesToRebuild: { type: 'array' },
        },
        required: ['rebuild'],
        additionalProperties: false,
      },
    };
    state.toolDefinitions.ide_lint_files = {
      input: { type: 'object', properties: { rebuild: { type: 'boolean' } } },
    };

    const cleanup = await plugin.setup(ctx);

    const build = state.toolDefinitions.ide_build_project.input;
    expect(build.properties).toEqual({ filesToRebuild: { type: 'array' } });
    expect(build).not.toHaveProperty('required');
    // Nothing else about the schema changes — this transform only takes away.
    expect(build.type).toBe('object');
    expect(build.additionalProperties).toBe(false);
    // Another tool that happens to have a `rebuild` property keeps it.
    expect(state.toolDefinitions.ide_lint_files.input.properties).toHaveProperty('rebuild');

    // The value half: an incremental build answers against the IDE's own view of
    // file freshness, so an edit made outside the IDE can produce a no-op that
    // reports success. Measured on IntelliJ 2026.2.3; see idea-tool-defaults.js.
    const before = state.toolHooks['execute.before'];
    expect(before).toBeTypeOf('function');
    const absent = { tool: 'ide_build_project', input: {} };
    await before(absent);
    expect(absent.input).toEqual({ rebuild: true });
    const explicit = { tool: 'ide_build_project', input: { rebuild: false, timeout: 60000 } };
    await before(explicit);
    expect(explicit.input).toEqual({ rebuild: true, timeout: 60000 });
    // Every other tool is left exactly as the model wrote it.
    const other = { tool: 'ide_lint_files', input: { files: ['src/A.java'] } };
    await before(other);
    expect(other.input).toEqual({ files: ['src/A.java'] });
    // A malformed event must not throw inside a hook OpenCode awaits.
    expect(() => before({})).not.toThrow();
    expect(() => before(undefined)).not.toThrow();

    await cleanup();
  });

  it('raises the directory-tree depth and warns when the tree is cut at the boundary', async () => {
    // 两个方向都不是"固定值":参数只抬下限(调用方给更大的值就照用),输出只追加一句提示。
    // 起因是一次真实会话:maxDepth=6 把 Java 包树切在包目录那一层,而输出里没有任何标记,
    // 模型把"被切"读成"空目录",整条查询链退回 shell。
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);

    // 参数侧:没传、传得太小、传了字符串,都抬到下限。
    const before = state.toolHooks['execute.before'];
    for (const draft of [{ directoryPath: 'src' }, { maxDepth: 6 }, { maxDepth: '6' }]) {
      const event = { tool: 'ide_list_directory_tree', input: draft };
      await before(event);
      expect(event.input.maxDepth).toBe(50);
    }
    // 调用方要更深的树 → 原样保留。
    const deeper = { tool: 'ide_list_directory_tree', input: { maxDepth: 200 } };
    await before(deeper);
    expect(deeper.input.maxDepth).toBe(200);

    // 输出侧:顶到边界 → 追加提示,原有内容不动。
    const after = state.toolHooks['execute.after'];
    const treeOf = (text, maxDepth) => ({
      tool: 'ide_list_directory_tree',
      status: 'completed',
      input: { maxDepth },
      result: { content: [{ type: 'text', text: JSON.stringify({ tree: text }) }] },
    });
    const cut = treeOf('    ├── a/\n    │   └── b/', 3);
    await after(cut);
    expect(cut.result.content).toHaveLength(2);
    expect(cut.result.content[1].text).toContain('maxDepth=3');

    // 没顶到边界 → 引用不变,结果原样。
    const full = treeOf('    ├── a/', 9);
    const before9 = full.result;
    await after(full);
    expect(full.result).toBe(before9);

    await cleanup();
  });

  it('reconnects and rewrites a dropped IDE tool error mid-turn', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(state.toolHook).toBeTypeOf('function');
    const mcpAfterCommand = state.mcp;

    // The IDE MCP drops mid-turn: no connected server, its tools gone.
    state.mcpServers = [];
    state.tools = [];

    const event = {
      tool: 'ide_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "ide" is not available' },
    };
    await state.toolHook(event);

    // Reconnected, tools reloaded, and the error now tells the model to retry.
    expect(state.mcp).toBe(mcpAfterCommand + 1);
    expect(event.error.message).toContain('已重新连接');

    await cleanup();
  });

  it('reconnects on the transport failure OpenCode actually reports (measured)', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    const afterOpen = state.mcp;

    // Measured against OpenCode 2.0.19 with the IDE process killed. None of the
    // older markers appeared; the client reported its own connect failure, which
    // used to classify as `none` — so a dead IDE silently never healed.
    const byMessage = {
      tool: 'ide_get_project_modules',
      sessionID: 's1',
      status: 'error',
      error: { message: 'Unable to connect. Is the computer able to access the url?' },
    };
    await state.toolHook(byMessage);
    expect(state.mcp).toBe(afterOpen + 1);
    expect(byMessage.error.message).toContain('已重新连接');

    // The same failure expressed structurally rather than by text.
    const byCode = {
      tool: 'ide_get_project_modules',
      sessionID: 's1',
      status: 'error',
      error: { message: 'something else entirely', error: { code: 'ConnectionRefused' } },
    };
    await state.toolHook(byCode);
    expect(state.mcp).toBe(afterOpen + 2);
    expect(byCode.error.message).toContain('已重新连接');

    await cleanup();
  });

  it('never reconnects on a business error, or on a message that merely mentions one', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;

    // The server still reports connected, so a failed call is a business error
    // (e.g. a bad path), not a dropped connection: leave it untouched.
    const business = {
      tool: 'ide_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'File not found: src/missing.kt' },
    };
    await state.toolHook(business);
    expect(state.mcp).toBe(mcpAfterCommand);
    expect(business.error.message).toBe('File not found: src/missing.kt');

    // The message of an MCP tool error is the tool's own content, so a query
    // against a stopped database reads exactly like a transport failure.
    const mentions = {
      tool: 'ide_execute_sql_query',
      sessionID: 's1',
      status: 'error',
      error: { message: 'java.net.ConnectException: Connection refused' },
    };
    await state.toolHook(mentions);
    expect(state.mcp).toBe(mcpAfterCommand);
    expect(mentions.error.message).toBe('java.net.ConnectException: Connection refused');

    await cleanup();
  });

  it('ignores tool errors in an unmarked project or for a non-IDEA tool', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    state.mcpServers = [];
    state.tools = [];

    // Unmarked project: the plugin stays out of the way.
    const unmarked = { tool: 'ide_read_file', sessionID: 's1', status: 'error', error: { message: 'boom' } };
    await state.toolHook(unmarked);
    expect(state.mcp).toBe(0);
    expect(unmarked.error.message).toBe('boom');

    // Marked project, but the failed tool is not an IDEA tool.
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    const mcpAfterCommand = state.mcp;
    const foreign = { tool: 'edit', sessionID: 's1', status: 'error', error: { message: 'boom' } };
    await state.toolHook(foreign);
    expect(state.mcp).toBe(mcpAfterCommand);
    expect(foreign.error.message).toBe('boom');

    await cleanup();
  });

  it('leaves the error untouched when the reconnect cannot reach the IDE', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    state.mcpServers = [];
    state.tools = [];

    const event = {
      tool: 'ide_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);

    // No reconnect happened, so the original error stays. The recovery guidance
    // still explains the manual fallback.
    expect(event.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('asks the IDE to reopen the project, but only when there is a launcher', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The IDE reports "project not open" in two shapes; both must reopen it.
    // Real text captured from IDEA 2026.2.3.
    for (const message of [
      'Unable to determine the target project for the current MCP tool call.',
      "`projectPath`=`/p` doesn't correspond to any open project.",
    ]) {
      openCalls.length = 0;
      const event = { tool: 'ide_read_file', sessionID: 's1', status: 'error', error: { message } };
      await state.toolHook(event);
      expect(openCalls.length).toBeGreaterThan(0);
      expect(event.error.message).toContain('重新打开');
    }

    await cleanup();

    // With no launcher there is nothing to call, so the plugin must NOT report
    // the project as reopened — that would send the model round after round
    // after a call that can never succeed. Leave the IDE's own error alone: it
    // names the real cause, and the user opens the project by hand.
    launcher.platform = 'win32';
    running = (await startFakeIdeForProject()).server;
    const withoutLauncher = fakeCtx({ ports: [running.address().port], toolRefreshTimeoutMs: 100 });
    const cleanup2 = await plugin.setup(withoutLauncher.ctx);
    await withoutLauncher.state.commands
      .get('open-in-ide')
      .execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    openCalls.length = 0;
    const message = 'Unable to determine the target project for the current MCP tool call.';
    const event = { tool: 'ide_read_file', sessionID: 's1', status: 'error', error: { message } };
    await withoutLauncher.state.toolHook(event);
    expect(openCalls).toHaveLength(0);
    expect(event.error.message).toBe(message);

    await cleanup2();
  });

  it('rebuilds the server when /open-in-ide is run again', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port] });
    const cleanup = await plugin.setup(ctx);
    const command = state.commands.get('open-in-ide');

    await command.execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    const transformsAfterFirst = state.mcp;
    const disposedAfterFirst = state.mcpDisposed;

    await command.execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The second run tears the old registration down (which is what kills the
    // bridge child) and registers a fresh one, so a zombie can never survive a
    // re-run of /open-in-ide.
    expect(state.mcp).toBe(transformsAfterFirst + 1);
    expect(state.mcpDisposed).toBeGreaterThan(disposedAfterFirst);
    expect(state.mcpReload).toBe(2);
    expect(state.toolReload).toBe(2);
    expect(state.prompts).toHaveLength(2);

    await cleanup();
  });

  it('does not auto-register from a persisted mark at setup', async () => {
    const port = await freePort();
    const fake = await startFakeIdeForProject(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    // Marked in a previous run, before OpenCode restarted.
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);

    // setup reads the mark (for skills) but does not connect by itself; the MCP
    // is registered by `/open-in-ide` (or on a classified tool failure).
    expect(state.mcp).toBe(0);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(state.mcp).toBe(1);

    await cleanup();
  });

  it('marks the project even when the command cannot reach the IDE', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 10, mcpStartTimeoutMs: 50, openInIde: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    // The mark means "this is an IDEA project", so it is set as soon as the
    // user asks, whether or not the IDE was reachable this time.
    expect(state.storage.get(`project/${projectPath}`)).toMatchObject(ideConfig(projectPath));

    await cleanup();
  });

  it('delete-in-ide unregisters the IDE MCP and clears the mark', async () => {
    const port = await freePort();
    const fake = await startFakeIdeForProject(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(state.storage.get(`project/${projectPath}`)).toMatchObject(ideConfig(projectPath));
    const disposedBefore = state.mcpDisposed;

    await state.commands.get('delete-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    expect(state.storage.has(`project/${projectPath}`)).toBe(false);
    expect(state.mcpDisposed).toBeGreaterThan(disposedBefore);
    expect(state.prompts.at(-1).metadata.displayText).toContain('已注销全部 IDE MCP');

    // Unmarked: a later connection failure is left alone.
    const mcpAfterClose = state.mcp;
    const event = {
      tool: 'ide_read_file',
      sessionID: 's1',
      status: 'error',
      error: { message: 'MCP server "idea" is not available' },
    };
    await state.toolHook(event);
    expect(state.mcp).toBe(mcpAfterClose);
    expect(event.error.message).toBe('MCP server "idea" is not available');

    await cleanup();
  });

  it('registers the hooks and resolves the project mark once', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    expect(state.sessionHooks.context).toBeTypeOf('function');
    expect(state.sessionHooks.prompt).toBeTypeOf('function');
    expect(state.toolHook).toBeTypeOf('function');

    // setup resolves the mark once; the tool hook reuses the cache.
    expect(state.storageGets).toBe(1);
    const ok = { tool: 'ide_read_file', sessionID: 's1', status: 'completed' };
    await state.toolHook(ok);
    expect(state.storageGets).toBe(1);

    // The command writes through: the next failed call still needs no storage read.
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    const err = { tool: 'ide_read_file', sessionID: 's1', status: 'error', error: { message: 'File not found' } };
    await state.toolHook(err);
    expect(state.storageGets).toBe(1);

    await cleanup();
  });

  it('keeps the skills through /open-in-ide and /delete-in-ide', async () => {
    // Their lifecycle follows the plugin instance, not the project mark: neither
    // connecting nor disconnecting may add or remove them. Registering on connect
    // is what made them invisible until a page reload; unregistering on delete
    // would be the same bug in the other direction.
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);
    const registered = [...state.skills.keys()].sort();
    expect(registered).toEqual(['idea-run-config-manager', 'idea-standalone']);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect([...state.skills.keys()].sort()).toEqual(registered);

    await state.commands.get('delete-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect([...state.skills.keys()].sort()).toEqual(registered);

    await cleanup();
  });

  it('is silent when feedback is false, and schedules no background timer', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { ctx, state } = fakeCtx({ openInIde: false, feedback: false });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });

    expect(state.prompts).toHaveLength(0);
    // Recovery is request-driven only. No polling means no `setInterval` at all,
    // which is also what keeps the IDE log free of per-probe warnings.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    await cleanup();
  });

  it('heals on the next real user message when the instance has no registration', async () => {
    // The eviction scenario: OpenCode disposed the Location's services (LayerMap
    // idleTimeToLive = 60 minutes) and this is the fresh plugin instance. The
    // project is still marked, but setup deliberately does not connect.
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 50, mcpProbeTimeoutMs: 10 });
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
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

  it('never launches the IDE while healing a marked project that was never opened', async () => {
    const { ctx, state } = fakeCtx({ ports: [1], mcpProbeTimeoutMs: 5 });
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
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

  it('reconnects on its own when a request arrives without the tools', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], mcpProbeTimeoutMs: 200, toolRefreshTimeoutMs: 200 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    // The session is serving...
    await state.sessionHooks.context({ system: [], tools: { read: {}, ide_read_file: {} } });
    const served = state.mcp;

    // ...and this request has no ide_* tool at all. No user message is involved:
    // waiting for one is the gap that left the session dead, because the `prompt`
    // hook for a message runs BEFORE the request that reveals the loss.
    await state.sessionHooks.context({ system: [], tools: { read: {} } });

    const deadline = Date.now() + 2000;
    while (state.mcp <= served && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state.mcp).toBeGreaterThan(served);
    // The reconnect republished the catalog.
    expect(state.tools.some((tool) => tool.id?.startsWith('ide_'))).toBe(true);

    await cleanup();
  });

  it('keeps a dropped IDE down on later requests until /open-in-ide re-registers it', async () => {
    const port = await freePort();
    const fake = await startFakeIdeForProject(port);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
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
    await state.commands.get('open-in-ide').execute({ sessionID: 's1', prompt: { text: 'idea' }, delivery: 'steer' });
    expect(state.mcp).toBe(2);
    expect(state.mcpReload).toBe(2);
    const request = { system: [], tools: { read: {}, ide_read_file: {} } };
    await state.sessionHook(request);
    expect(request.tools).toHaveProperty('ide_read_file');
    expect(request.system).toHaveLength(2);

    await cleanup();
  });
});

describe('多项目接入（root + 子项目，各自用不同 IDE）', () => {
  /** 一个真实存在的子项目目录；它位于 root 之下，所以随 afterAll 一起被清掉。 */
  const childPath = path.join(projectPath, 'modelserver');
  mkdirSync(childPath, { recursive: true });
  /** 目录真实存在，但名字不符合工具前缀规则。 */
  const badNamePath = path.join(projectPath, 'ModelServer.v2');
  mkdirSync(badNamePath, { recursive: true });

  /** 一个已登记 root + modelserver 的配置。 */
  const twoProjects = () => ({
    root: { path: projectPath, app: 'idea' },
    children: [{ path: childPath, app: 'pycharm' }],
  });

  it('首次 /open-in-ide 不猜 IDE，而是让模型去问用户', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({
      sessionID: 's1',
      prompt: { text: '' },
      delivery: 'steer',
    });

    // 没有配置、也没带参数 → 不连、不写；发一条**任务**让模型问用户并回写。
    expect(state.mcp).toBe(0);
    expect(state.storage.has(`project/${projectPath}`)).toBe(false);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0].text).toContain('configure_ide_project');
    expect(state.prompts[0].metadata.displayText).toContain('IntelliJ IDEA');
    expect(state.prompts[0].metadata.displayText).toContain('PyCharm');

    // 实测踩过:模型收到"问用户选哪个 IDE"后自己跑 `ps aux | grep`,那只看到**正在运行**
    // 的进程 —— PyCharm 装了没开就被报成"未发现"。所以插件自己按应用目录探一次,把结论写进
    // 任务文本,并明确禁止模型再去翻进程。
    // 判据是**行为**:插件自己探了(而不是让模型去探),探到的结论进了任务文本。
    // 结论里"装了什么 / 缺什么"的具体措辞不归测试管。
    const text = state.prompts[0].text;
    const detected = text.slice(0, text.indexOf('请向用户提问'));
    expect(detected.length).toBeGreaterThan(0);
    expect(detected).toContain('IntelliJ IDEA');

    await cleanup();
  });

  it('probes the local IDE inventory itself and puts the result in the task', async () => {
    // 实测踩过:模型收到"问用户选哪个 IDE"后自己跑 `ps aux | grep`,那只看到**正在运行**
    // 的进程 —— PyCharm 装了没开就被报成"未发现"。所以插件自己按应用目录探一次,把结论写进
    // 任务文本,并明确禁止模型再去翻进程。
    // 判据是**行为**:探到了就把结论写进任务;没探到就不写(那段"没探出来"不等于"没装",
    // 所以宁可不提,也不能瞎说)。结论长什么样不归测试管。
    const ask = async () => {
      const { ctx, state } = fakeCtx();
      const cleanup = await plugin.setup(ctx);
      await state.commands.get('open-in-ide').execute({
        sessionID: 's1',
        prompt: { text: '' },
        delivery: 'steer',
      });
      const text = state.prompts[0].text;
      await cleanup();
      return text;
    };

    const withProbe = await ask();
    expect(withProbe).toContain('configure_ide_project');

    launcher.installedIdes = [];
    const withoutProbe = await ask();
    expect(withoutProbe).toContain('configure_ide_project');
    // 探到的那段结论整段都不在 → 文本更短。
    expect(withoutProbe.length).toBeLessThan(withProbe.length);
  });

  it('configure_ide_project 写入用户选的 root IDE，然后接入', async () => {
    const fake = await startFakeIdeForProject();
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    const cleanup = await plugin.setup(ctx);

    const tool = state.registeredTools.configure_ide_project;
    expect(tool).toBeTypeOf('object');
    const result = await tool.execute({ ide: 'pycharm' });

    expect(result.content).toContain('PyCharm');
    expect(state.storage.get(`project/${projectPath}`)).toMatchObject({
      root: { path: projectPath, app: 'pycharm' },
      children: [],
    });
    expect(state.mcp).toBe(1);
    // root 的前缀与 IDE 产品无关：用 PyCharm 打开也叫 `ide`。
    expect(state.mcpConfig.name).toBe('ide');

    await cleanup();
  });

  it('configure_ide_project 拒绝不是 IDE 的值', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    const result = await state.registeredTools.configure_ide_project.execute({ ide: 'vscode' });

    expect(result.content).toContain('不支持的 IDE');
    expect(state.storage.has(`project/${projectPath}`)).toBe(false);

    await cleanup();
  });

  it('add-sub-module-in-ide 在没有配置时直接报错，并要求先 /open-in-ide', async () => {
    const { ctx, state } = fakeCtx();
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('add-sub-module-in-ide').execute({
      sessionID: 's1',
      prompt: { text: 'modelserver' },
      delivery: 'steer',
    });

    expect(state.storage.has(`project/${projectPath}`)).toBe(false);
    expect(state.mcp).toBe(0);
    expect(state.prompts.at(-1).metadata.displayText).toContain('请先执行 /open-in-ide');

    await cleanup();
  });

  it('add-sub-module-in-ide 只收一个参数，并先校验路径再提问', async () => {
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);
    const command = state.commands.get('add-sub-module-in-ide');

    // 多给参数 = 错误，不猜。
    await command.execute({ sessionID: 's1', prompt: { text: 'modelserver pycharm' }, delivery: 'steer' });
    expect(state.prompts.at(-1).metadata.displayText).toContain('只接受一个参数');

    // 目录不存在：拒绝。
    await command.execute({ sessionID: 's1', prompt: { text: 'nope' }, delivery: 'steer' });
    expect(state.prompts.at(-1).metadata.displayText).toContain('目录不存在');

    // 合法：发起提问（写配置由模型调用工具完成）。
    await command.execute({ sessionID: 's1', prompt: { text: 'modelserver' }, delivery: 'steer' });
    const asked = state.prompts.at(-1);
    expect(asked.text).toContain('configure_ide_project');
    expect(asked.text).toContain('path: "modelserver"');
    expect(state.storage.get(`project/${projectPath}`).children).toHaveLength(0);

    await cleanup();
  });

  it('登记子项目后给每个项目各注册一个 server，各自指向自己的路径', async () => {
    const rootPort = await freePort();
    const childPort = await freePort();
    const rootIde = await startFakeIdeForProject(rootPort);
    const childIde = await startFakeIde(childPort);
    // 各认各的项目：这正是"端口归属"要区分的东西。
    childIde.setProjectOpen(childPath, true);
    running = [rootIde.server, childIde.server];

    const { ctx, state } = fakeCtx({ ports: [rootPort, childPort], toolRefreshTimeoutMs: 100 });
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);

    await state.registeredTools.configure_ide_project.execute({ path: 'modelserver', ide: 'pycharm' });

    const byName = Object.fromEntries(state.mcpConfigs.map((entry) => [entry.name, entry.config]));
    expect(Object.keys(byName).sort()).toEqual(['ide', 'modelserver']);
    expect(byName.ide.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe(projectPath);
    expect(byName.modelserver.headers.IJ_MCP_SERVER_PROJECT_PATH).toBe(childPath);
    // 两个项目在两个不同的 IDE 进程里 —— 也就是两个端口。
    expect(byName.ide.url).toContain(`:${rootPort}/stream`);
    expect(byName.modelserver.url).toContain(`:${childPort}/stream`);

    await cleanup();
  });

  it('拒绝目录名不合法的子项目（大小写 / 点号）', async () => {
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);

    const result = await state.registeredTools.configure_ide_project.execute({
      path: 'ModelServer.v2',
      ide: 'pycharm',
    });

    expect(result.content).toContain('无法登记子项目');
    expect(state.storage.get(`project/${projectPath}`).children).toHaveLength(0);

    await cleanup();
  });

  it('拒绝会与已登记项目重名的子项目', async () => {
    const { ctx, state } = fakeCtx();
    state.storage.set(`project/${projectPath}`, twoProjects());
    const cleanup = await plugin.setup(ctx);

    // 另建一个同名目录（不同层级），前缀会撞车。
    const nested = path.join(childPath, 'modelserver');
    mkdirSync(nested, { recursive: true });
    const result = await state.registeredTools.configure_ide_project.execute({
      path: 'modelserver/modelserver',
      ide: 'idea',
    });

    expect(result.content).toContain('已被');
    expect(state.storage.get(`project/${projectPath}`).children).toHaveLength(1);

    await cleanup();
  });

  it('按每个前缀清洗工具，子项目那份也不例外', async () => {
    const fake = await startFakeIdeForProject();
    fake.setProjectOpen(childPath, true);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    state.storage.set(`project/${projectPath}`, twoProjects());
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({
      sessionID: 's1',
      prompt: { text: 'idea' },
      delivery: 'steer',
    });

    const request = {
      system: [],
      tools: {
        ide_read_file: {},
        ide_git_status: {},
        modelserver_read_file: {},
        modelserver_git_status: {},
      },
    };
    await state.sessionHook(request);

    expect(request.tools).toHaveProperty('ide_read_file');
    expect(request.tools).toHaveProperty('modelserver_read_file');
    expect(request.tools).not.toHaveProperty('ide_git_status');
    // 子项目那份同样要被清掉 —— 只处理 `ide_` 前缀是这次改动最容易犯的错。
    expect(request.tools).not.toHaveProperty('modelserver_git_status');

    await cleanup();
  });

  it('逐项目注入提示词：每个项目只看到自己前缀的工具', async () => {
    const fake = await startFakeIdeForProject();
    fake.setProjectOpen(childPath, true);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    state.storage.set(`project/${projectPath}`, twoProjects());
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({
      sessionID: 's1',
      prompt: { text: 'idea' },
      delivery: 'steer',
    });

    const request = {
      system: [],
      tools: { ide_read_file: {}, modelserver_read_file: {} },
    };
    await state.sessionHook(request);

    const guidance = request.system.at(-1).text;
    expect(guidance).toContain('`ide_search_symbol`');
    expect(guidance).toContain('`modelserver_search_symbol`');
    expect(guidance).toContain('IntelliJ IDEA');
    expect(guidance).toContain('PyCharm');
    // 公共段只出一次。
    expect(guidance.match(/# IDE MCP:OpenCode 自带工具的补充/g)).toHaveLength(1);

    await cleanup();
  });

  it('在非 macOS 上连子项目也不拉起 IDE(与 IDEA 同一套规则)', async () => {
    // 旧逻辑:非 mac 一律不 open。加了 PyCharm 之后这条不能只对 idea 成立 ——
    // `appNameFor` 与 app 无关,所以 pycharm 同样拿不到 app,走到 manual-launch。
    launcher.platform = 'win32';
    // 这个 fake IDE 认得 modelserver 这个项目 —— 但它是以子项目身份接进来的。
    const fake = await startFakeIde();
    fake.setProjectOpen(childPath, true);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    state.storage.set(`project/${projectPath}`, ideConfig(projectPath));
    const cleanup = await plugin.setup(ctx);

    openCalls.length = 0;
    // 登记子项目(PyCharm)并接入。
    await state.registeredTools.configure_ide_project.execute({ path: 'modelserver', ide: 'pycharm' });

    // 从来不请求拉起:Windows 上没有 `open -a`。
    expect(openCalls).toHaveLength(0);
    // 但已经打开着的端点照样连上 —— 不拉起 ≠ 不能用。
    expect(state.mcp).toBeGreaterThan(0);

    await cleanup();
  });

  it('delete-in-ide 删掉整个配置，子项目一并清掉', async () => {
    const fake = await startFakeIdeForProject();
    fake.setProjectOpen(childPath, true);
    running = fake.server;
    const { ctx, state } = fakeCtx({ ports: [fake.port], toolRefreshTimeoutMs: 100 });
    state.storage.set(`project/${projectPath}`, twoProjects());
    const cleanup = await plugin.setup(ctx);

    await state.commands.get('open-in-ide').execute({
      sessionID: 's1',
      prompt: { text: 'idea' },
      delivery: 'steer',
    });
    expect(state.mcpConfigs).toHaveLength(2);

    await state.commands.get('delete-in-ide').execute({
      sessionID: 's1',
      prompt: { text: '' },
      delivery: 'steer',
    });

    expect(state.storage.has(`project/${projectPath}`)).toBe(false);
    expect(state.prompts.at(-1).metadata.displayText).toContain('已删除本项目的 IDE 配置');

    await cleanup();
  });
});
