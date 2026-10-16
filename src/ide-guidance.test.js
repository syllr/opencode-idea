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
      '→ 根项目 `ide_search_symbol` ｜ modelserver `modelserver_search_symbol`',
    );
    // 功能说明只出现一次:没有"按项目各抄一遍"的第二段。
    expect(text.match(/按名字找符号的声明位置/g)).toHaveLength(1);
    expect(text.match(/### 符号/g)).toHaveLength(1);
  });

  it('teaches the library-source workflow, per language', () => {
    // 实测出来的核心价值:默认不搜库,带上 include_external 才能命中依赖源码。而"怎么读"
    // 随语言不同 —— JVM 的依赖在压缩包里(只有 IDE 的 read_file 能读),Python / Node / Go
    // 的依赖就是磁盘上的普通文件(原生 read 直接读)。写成一种语言的例子会误导其它语言。
    const text = stock();
    expect(text).toContain('include_external: true');
    expect(text).toContain('sources.jar!');
    expect(text).toContain('Python');
    expect(text).toContain('node_modules');
    // 相对路径这个坑:搜索返回的是相对**该项目根**的路径,而会话 cwd 是根项目。
    expect(text).toContain('相对「该项目根」');
    expect(text).toContain('会读到别的文件');
    // "不加 search_text 那 AI 怎么找依赖里的文本" —— 答案是从 symbol 搜索的返回路径推出依赖目录,
    // 再用原生 grep/glob 搜;并说明 search_text 那三个够不着依赖(实测传项目外路径直接报错)。
    expect(text).toContain('依赖的物理目录');
    expect(text).toContain('points to the location outside of the project directory');
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

  it('scopes read_file to archive entries, with a checkable test', () => {
    // 规则必须给**可操作的判据**(路径里有没有 `.jar!/`),不能只说"包内文件"这种术语 ——
    // 实测模型就是靠不住这个概念,才拿它去读普通文件。
    const text = stock();
    expect(text).toContain('读压缩包里的条目');
    expect(text).toContain('.jar!/');
    expect(text).toContain('反编译');
    expect(text).toContain('一律用原生 `read`');
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
    for (const line of text.split('\n').filter((l) => l.includes('→ 根项目'))) {
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
      '→ 根项目 `ide_rerun_run_configuration` ｜ modelserver `modelserver_rerun_run_configuration`',
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
    expect(text).toContain('→ 根项目 `ide_search_symbol`');
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
    expect(MCP_RECOVERY_GUIDANCE).toContain('/open-in-idea');
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
