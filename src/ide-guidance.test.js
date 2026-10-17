import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidanceText,
} from './ide-guidance.js';

const ROOT = {
  path: '/Users/me/project',
  server: 'ide',
  app: 'idea',
  label: '.',
  isRoot: true,
};
const CHILD = {
  path: '/Users/me/project/modelserver',
  server: 'modelserver',
  app: 'pycharm',
  label: 'modelserver',
  isRoot: false,
};

/** 两个项目的会话,IDE 只提供内置工具（没装配套插件）。 */
const stock = () => buildIdeGuidanceText([ROOT, CHILD], { tools: {} });

describe('项目清单', () => {
  it('lists the root and every subproject with its own MCP tool prefix', () => {
    const text = stock();
    expect(text).toContain('## 本会话接入的项目与各自的 MCP 工具');
    expect(text).toContain('- **根项目** `.`(IntelliJ IDEA 打开)→ MCP 工具前缀 `ide_*`');
    expect(text).toContain(
      '- **子项目** `modelserver`(PyCharm 打开)→ MCP 工具前缀 `modelserver_*`',
    );
    // 项目路径也在清单里（模型可能拿到绝对路径）。
    expect(text).toContain(ROOT.path);
    expect(text).toContain(CHILD.path);
  });

  it('marks the root project as excluding the subprojects', () => {
    // 子项目就在根目录的目录树里,不写明"扣掉",模型就得自己猜 modelserver 的文件算谁的。
    const text = stock();
    expect(text).toContain('**子项目就是根目录下的目录**');
    expect(text).toContain('根目录中扣掉这些子项目之后的部分');
    expect(text).toContain('**不含下列子项目**');
  });

  it('does not claim exclusions when the root is the only project', () => {
    const text = buildIdeGuidanceText([ROOT], { tools: {} });
    expect(text).not.toContain('**不含下列子项目**');
  });

  it('states the routing rule and points at subproject AGENTS.md on demand', () => {
    // 子项目的 AGENTS.md 不会自动进上下文(OpenCode 只按 cwd 向上收集,而 cwd 是 root)。
    const text = stock();
    expect(text).toContain('操作哪个目录下的文件/代码,就用那个目录对应的命令');
    expect(text).toContain('按需读文件');
    expect(text).toContain('AGENTS.md');
  });
});

describe('工具清单(按功能,不按项目重复)', () => {
  it('writes each capability once, with every project command after the arrow', () => {
    const text = stock();
    expect(text).toContain(
      '根项目 `ide_search_symbol` ｜ modelserver `modelserver_search_symbol`',
    );
    // 功能说明只出现一次:没有"按项目各抄一遍"的第二段。
    expect(text.match(/按名字找符号的声明位置/g)).toHaveLength(1);
    expect(text.match(/### 符号/g)).toHaveLength(1);
  });

  it('teaches the library-source workflow with one rule, not one per language', () => {
    // 核心只有一句:搜索给的路径**原样**交给同一个项目的 read_file。两者同属一个项目、路径基准
    // 一致,所以既不用按语言分岔,也不用拼绝对路径 —— 之前那版"按语言区分 + 拼绝对路径 + 走原生 read"
    // 是自找的复杂度(实测原样传过去 24ms 就读到了)。
    const text = stock();
    expect(text).toContain('固定带上 `include_external: true`');
    expect(text).toContain('本插件最不可替代的能力');
    // 正向流程:①已知名字(代码里看到调用)②只记得关键字(调研库的 API,按返回路径筛出属于那个库的);
    // 同名多份时按 import/类型/路径消歧。
    expect(text).toContain('典型用法 ①');
    expect(text).toContain('典型用法 ②');
    // 最典型的用法:代码里的 import 直接给出包名,用「包名+符号」搜一次定位。
    // 四种语言各自的形式都实测过(Java 全限定名 / Go 包名.符号 / Python 全模块路径 / Node 用 import 的包名)。
    expect(text).toContain('包名就在代码里');
    expect(text).toContain('gorm.DeletedAt');
    expect(text).toContain('vue.Teleport');
    expect(text).toContain('torch.nn.modules.module.Module');
    // 边界说清楚:只覆盖项目已引入的依赖;搜不到就别反复试,给两条出路。
    expect(text).toContain('只覆盖「项目已经引入」的依赖');
    // 用法 ②:包名从依赖清单拿(Python/Java/Go 直接按包名搜),Node 是例外。
    expect(text).toContain('包名从依赖清单里拿');
    expect(text).toContain('element-plus');
    // Node 的收敛:带 -/@scope 的包名点号拼接无效,只能裸符号名 + paths 圈目录。
    expect(text).toContain('就收敛到一处');
    expect(text).toContain('按代码上下文选');
    expect(text).toContain('原样交给同一个项目的');
    expect(text).toContain('相对路径的基准一致');
    expect(text).toContain('别把这条路径交给原生 `read`');
    // 依赖索引按项目走,不按语言 —— 语言与 IDE 的对应是用户配置的结果,写死"Python→PyCharm"
    // 换个配置就不对了。实测:同一个 uvicorn,根项目侧搜不到库,子项目侧能搜到。
    expect(text).toContain('依赖索引是按项目的');
    expect(text).toContain('它所在项目');
    // "按语言分岔"的写法不该再出现。
    expect(text).not.toContain('**Java / Kotlin**');
    // 也不该教它"从路径反推依赖目录再用 grep 搜" —— 那是模型本来就会的事。
    expect(text).not.toContain('依赖的物理目录');
  });

  it('covers every routed capability', () => {
    const text = stock();
    for (const suffix of [
      'search_symbol',
      'get_symbol_info',
      'analyze_calls',
      'list_directory_tree',
      'get_project_modules',
      'get_project_dependencies',
      'get_all_open_file_paths',
      'open_file_in_editor',
      'rename_refactoring',
      'reformat_file',
      'lint_files',
      'get_file_problems',
      'build_project',
      'read_file',
      'get_run_configurations',
      'execute_run_configuration',
    ]) {
      // 每条功能后面都要有**两个项目**的命令名。
      expect(text).toContain(`\`ide_${suffix}\``);
      expect(text).toContain(`\`modelserver_${suffix}\``);
    }
  });

  it('states the parameters and the positive flow for each capability', () => {
    const text = stock();
    expect(text).toContain('`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`');
    expect(text).toContain('`childOffset` 翻页');
    expect(text).toContain('EXECUTE_IN_TERMINAL: false');
    expect(text).toContain('supportsDynamicLaunchOverrides');
    expect(text).toContain('没返回即没问题');
  });

  it('keeps the owned build argument and the hidden terminal tool out', () => {
    const text = stock();
    expect(text).not.toContain('rebuild');
    expect(text).not.toContain('execute_terminal_command');
    expect(text).not.toContain('executeInShell');
    expect(text).not.toContain('白名单');
  });

  it('routes only IDE-only capabilities here; reading and searching stay native', () => {
    const text = stock();
    expect(text).toContain('只有 IDE 才有的能力才用它们');
    expect(text).toContain('读写与搜索用原生工具');
    expect(text).not.toContain('## 例外');
    expect(text).not.toContain('版本控制用原生');
  });

  it('scopes read_file to what native cannot do', () => {
    // 它的独特能力:压缩包内的条目(含 .class 反编译)。这块不必再重复总则里的"普通文件用原生 read"。
    const text = stock();
    expect(text).toContain('压缩包内的条目');
    expect(text).toContain('.jar!/');
    expect(text).toContain('反编译');
    expect(text).toContain('「符号」那条搜出来的路径也用它');
  });

  it('writes no caveats or edge cases', () => {
    for (const caveat of [
      '不要传',
      '静默',
      'timedOut',
      'No more rows',
      'Query executed successfully',
      '外部客户端的看不到',
      '一堆同名符号',
      '只能读项目',
    ]) {
      expect(stock()).not.toContain(caveat);
    }
  });

  it('names each project only once per command list', () => {
    const text = stock();
    // 每条 cmd_* 都长成 "根项目 `命令` ｜ 子项目名 `命令`"，没有第三份。
    for (const line of text.split('\n').filter((l) => l.startsWith('- 根项目'))) {
      expect(line.match(/`ide_/g)?.length).toBe(1);
      expect(line.match(/`modelserver_/g)?.length).toBe(1);
    }
  });
});

describe('run-lifecycle 能力', () => {
  it('says nothing about them for stock IDEes', () => {
    const text = stock();
    for (const suffix of [
      'create_shell_run_configuration',
      'list_running_configurations',
      'stop_run_configuration',
      'rerun_run_configuration',
    ]) {
      expect(text).not.toContain(suffix);
    }
  });

  it('lists them once the companion plugin serves them', () => {
    const tools = {
      'ide_rerun_run_configuration': {},
      'modelserver_rerun_run_configuration': {},
      'ide_list_running_configurations': {},
      'modelserver_list_running_configurations': {},
    };
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools });
    expect(text).toContain(
      '**改完代码重启无热重载的进程**',
    );
    expect(text).toContain(
      '根项目 `ide_rerun_run_configuration` ｜ modelserver `modelserver_rerun_run_configuration`',
    );
    expect(text).toContain('`ide_list_running_configurations`');
    // 只在清单里出现一次,不重复成两段。
    expect(text.match(/\*\*改完代码重启无热重载的进程\*\*/g)).toHaveLength(1);
  });

  it('offers one when only one project serves it', () => {
    // 提示词只有一份,所以"这套能力在本次会话里存不存在"由任一项目决定。
    const text = buildIdeGuidanceText([ROOT, CHILD], {
      tools: { 'modelserver_rerun_run_configuration': {} },
    });
    expect(text).toContain('**改完代码重启无热重载的进程**');
    expect(text).toContain('`modelserver_rerun_run_configuration`');
  });
});

describe('单项目', () => {
  it('renders one project without the subproject framing', () => {
    const text = buildIdeGuidanceText([ROOT], { tools: {} });
    expect(text).toContain('本会话接入了 1 个 JetBrains 项目');
    expect(text).toContain('- **根项目** `.`(IntelliJ IDEA 打开)→ MCP 工具前缀 `ide_*`');
    expect(text).toContain('根项目 `ide_search_symbol`');
    expect(text).not.toContain('modelserver_');
  });
});

describe('appendIdeGuidance', () => {
  it('appends once and is idempotent per request', () => {
    const system = [];
    appendIdeGuidance(system, [ROOT], { tools: {} });
    expect(system).toHaveLength(1);
    appendIdeGuidance(system, [ROOT], { tools: {} });
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain('`ide_search_symbol`');
  });

  it('does nothing without projects or a system array', () => {
    const system = [];
    appendIdeGuidance(system, [], { tools: {} });
    expect(system).toHaveLength(0);
    expect(() => appendIdeGuidance(undefined, [ROOT], { tools: {} })).not.toThrow();
  });
});

describe('appendIdeRecoveryGuidance', () => {
  it('picks the auto-reconnect variant for a configured project', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true, serving: true });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_MARKED }]);
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('reconnects the IDE MCP automatically');
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('retry the operation once');
  });

  it('picks the reconnecting variant when the tools are not in this request', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_RECONNECTING }]);
    expect(MCP_RECOVERY_GUIDANCE_RECONNECTING).toContain('Do NOT call any of them now');
  });

  it('picks the plain variant for an unconfigured project', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: false, serving: false });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE }]);
    expect(MCP_RECOVERY_GUIDANCE).toContain('/open-in-ide');
  });

  it('never names a bare `idea_` prefix', () => {
    for (const text of [
      MCP_RECOVERY_GUIDANCE,
      MCP_RECOVERY_GUIDANCE_MARKED,
      MCP_RECOVERY_GUIDANCE_RECONNECTING,
    ]) {
      expect(text).not.toContain('idea_');
    }
  });
});
