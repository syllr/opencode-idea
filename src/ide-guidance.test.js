import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidanceText,
} from './ide-guidance.js';

/**
 * 折叠空白再比 —— 引导文本会被 IDE 的 Markdown 格式化器重排(长行折行、括号前插空格),
 * 断言只关心**内容**,不关心排版:否则每次格式化都会红一片。
 *
 * @param {string} text
 */
const flat = (text) => text.replace(/\s+/g, ' ');

/**
 * 去掉**所有**空白再比 —— `flat` 只能折叠空白,吸收不了格式化工具**插入**的空格
 * (它在中文与 `**` 之间会加一个)。断言的是"这几段字在不在",排版怎么变都不该让它红。
 *
 * @param {string} text
 */
const tight = (text) => text.replace(/\s+/g, '');

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

/**
 * 部署那节的标题 —— 模板里的字面量。
 *
 * 只写在这一处:它同时是"这一节在不在"的判据(整节连标题一起受 `{{#if}}` 控制),
 * 所以断言里每处都用它,改标题时不会漏掉某一条。
 */
const DEPLOYMENT_HEADING = '### 服务器文件同步';

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
    expect(text.match(/本插件最不可替代的能力/g)).toHaveLength(1);
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
    expect(text).toContain('读与搜索用原生工具');
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

describe('看依赖实现只有一条路(javap 的坑)', () => {
  it('front-loads the two-step route as the first thing under the heading', () => {
    // 实测失效(idea-mcp-enhance 会话):整个会话 398 次 shell,reasoning 里 javap 出现 175 次,
    // search_symbol 只在用户开口之后才出现 —— 老文案把这条写成了"找声明位置的技巧",模型当时的
    // 问题是"这个平台方法到底怎么实现的",两边根本对不上。所以先把"要看实现"这个动因写在最前。
    const text = stock();
    expect(text).toContain('要读任何类 / 方法 / 字段的源码,就两步');
    // 总则里也点一句,那是每条路由规则都会路过的地方。
    // ("只有一条路"这个定性后来从总则那行去掉了 —— 总则只留动因与两步走法,
    //  禁止替代手艺的话挪进了「符号」小节,见下面那条。)
    expect(text).toContain('**要看某个类 / 方法 / 字段在哪定义、内部怎么实现的**');
  });

  it('bans the javap / unzip route instead of merely offering the tool', () => {
    const text = stock();
    // 只写"我能搜符号"拦不住 `javap -c -p -cp <自己拼的 jar 路径>` —— 那是模型的默认手艺,
    // 必须把话说到"替代路走不通",并给出它自己的理由(副本 / 字节码清单)。
    // 这一句 77cc21f 从总则挪进了「符号」小节,写法也从"不要用 X"换成把 X 收成"唯一的正解":
    // 反正 javap / unzip / 解包 jar / 按 jar 路径 grep 这几条都被点名成"只有这样一条路"。
    expect(flat(text)).toContain(flat('也是 `javap` / `unzip` / 解包 jar / 按 jar 路径 `grep` 唯一的正解'));
    expect(text).toContain('编译时真正用的依赖');
    expect(text).toContain('另一份副本');
    expect(text).toContain('反编译源码');
    // 依赖库正是这套的主要用场,不是"顺带也能搜到"。
    expect(text).toContain('正是它最该用的场合');
  });

  it('puts the instruction first in the search_symbol bullet', () => {
    const text = stock();
    // 参数与固定值必须在最前面,机制解释随后 —— 模型是扫读的。
    expect(text).toContain('**`q` 传查询文本,固定带上 `include_external: true`。**');
  });
});

describe('校验(改完代码自己先查一遍)', () => {
  it('makes the model verify on its own instead of only being offered the tools', () => {
    // 实测过的失效:工具清单里写着 lint/build,模型却当没看见,自己去 shell 里编一遍就宣布完成。
    // 所以这一节必须先给出"要查"这件事,再讲怎么挑 —— 只列工具等于没提醒。
    const text = stock();
    expect(text).toContain('改完代码自己先查一遍');
    // 判断权留给模型:不是每步都查,也不是不查。
    expect(text).toContain('这不是流程要求,是你自己的判断');
    // 两个失效方向都点名:查太勤和压根不查。
    expect(text).toContain('中途不查');
    expect(text).toContain('别把校验整段省掉');
  });

  it('gives one rule per editing shape, keyed to what the model knows', () => {
    const text = stock();
    // 判据必须是模型自己掌握的信息(这轮改了什么、还打算改多少),不是外部信号。
    expect(text).toContain('这次要改一大片');
    expect(text).toContain('全部改完再 `build_project` 一次');
    expect(text).toContain('这次只改一处,或在同一个文件上反复微调');
    expect(text).toContain('把这轮改过的文件一次 `lint_files` 掉');
    // 跨文件影响面决定用哪个工具。
    expect(text).toContain('签名 / 接口 / import / 依赖');
    expect(text).toContain('lint 就够');
  });

  it('asks for the reported problems to be handled, and keeps IDE tools primary', () => {
    const text = stock();
    // 只查不处理等于把噪音原样交给用户。
    expect(text).toContain('改掉,或说清为什么不改');
    // 观察到的绕路:自己去 shell 里临时编译 → 必须写明那不是等价物。
    expect(text).toContain('不要改用 `shell` 里临时自己编一遍代替');
  });
});

describe('run-lifecycle 能力', () => {
  it('says nothing about them for stock IDEes', () => {
    const text = stock();
    for (const suffix of [
      'create_run_configuration',
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

  it('routes the work it cannot do to the run-configuration manager skill', () => {
    // Non-Shell types, and delete and edit, have no tool at all. The handoff is
    // not a bare "ask the user": it names the one skill that owns those flows —
    // and that skill is user-invoked, so the model never picks it up by itself.
    const text = buildIdeGuidanceText([ROOT, CHILD], {
      tools: { 'ide_create_run_configuration': {} },
    });
    expect(text).toContain('`idea-run-config-manager` skill');
    // 档案同步是那个 skill 的职责;工具只负责把配置写对。
    expect(text).toContain('改完别忘了同步档案');
    // 提示词里必须保留"不要手写 / 手删 `.run/` 下的文件"这条总禁令。
    expect(flat(text)).toContain(flat('不要手写或手删 `.run/` 下的文件'));
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

describe('部署能力', () => {
  it('leaves the whole section out for a stock IDE', () => {
    // 这一组整节都只由配套插件提供(run-lifecycle 那节还有内置的 get/execute 撑着),
    // 所以工具不在时**标题也要消失** —— 留个空壳标题只会让模型去找一个不存在的工具。
    // 判据锚在 `list_deployment_servers` 上:配套插件装了,这一组就一起出现在工具表里。
    const text = stock();
    expect(text).not.toContain(DEPLOYMENT_HEADING);
    for (const suffix of [
      'list_deployment_servers',
      'upload_to_deployment',
      'download_from_deployment',
      'get_deployment_task_status',
    ]) {
      expect(text).not.toContain(suffix);
    }
  });

  it('anchors the whole section on the one tool it names first', () => {
    // 锚点是一个工具,不是"四个里任一个"的聚合判断:锚点缺席 = 这一组就没装进来,整节
    // (含标题)不出现。所以缺锚点、只多出别的几个时,整节也不出现 —— 这是刻意的,
    // 因为这四个由同一道前提注册、同进同出。
    const text = buildIdeGuidanceText([ROOT], {
      tools: { 'ide_upload_to_deployment': {}, 'ide_get_deployment_task_status': {} },
    });
    expect(text).not.toContain(DEPLOYMENT_HEADING);
    expect(text).not.toContain('`ide_upload_to_deployment`');
  });

  it('lists them once the companion plugin serves them, per project prefix', () => {
    const tools = {
      'ide_list_deployment_servers': {},
      'modelserver_list_deployment_servers': {},
      'ide_upload_to_deployment': {},
      'ide_download_from_deployment': {},
      'ide_get_deployment_task_status': {},
    };
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools });
    expect(text).toContain(DEPLOYMENT_HEADING);
    expect(text).toContain(
      '根项目 `ide_list_deployment_servers` ｜ modelserver `modelserver_list_deployment_servers`',
    );
    expect(text).toContain('`ide_upload_to_deployment`');
    expect(text).toContain('`ide_download_from_deployment`');
    expect(text).toContain('`ide_get_deployment_task_status`');
  });

  it('keeps upload and download off hand-rolled ssh / rsync / scp', () => {
    // 这条才是这节存在的理由:自己拼一份传输与 IDE 看到、管理的不是同一份
    // (连接、路径映射、排除规则都在插件后面),而 IDE 的那份正是用户配置出来的。
    const text = buildIdeGuidanceText([ROOT], {
      tools: {
        'ide_list_deployment_servers': {},
        'ide_upload_to_deployment': {},
        'ide_download_from_deployment': {},
      },
    });
    expect(text).toContain('**别用 `ssh` / `rsync` / `scp` 自己拼一份**');
    // mirror 的破坏性必须在文案里明说 —— 它是默认值,而且这里没有确认步骤。
    expect(text).toContain('`mode` 默认 `mirror`');
    expect(text).toContain('**会删掉服务器上多出来的文件**');
    // 下载以远端为准,没有"保留我的版本";不写清楚,模型会以为那是可选项。
    expect(text).toContain('**以服务器为准**');
    expect(text).toContain('**没有"保留我的版本"这个选项**');
  });

  it('teaches that in_progress is normal, and how to follow it up', () => {
    // 单次调用只等到 waitMs;把它读成失败就会让模型重试 —— 那要么是白等,
    // 要么是另起一次传输。查进度只有 handle 这一条路。
    const text = buildIdeGuidanceText([ROOT], {
      tools: {
        'ide_list_deployment_servers': {},
        'ide_get_deployment_task_status': {},
        'ide_upload_to_deployment': {},
      },
    });
    expect(tight(text)).toContain(tight('返回 `in_progress` 是**正常**的,不是失败'));
    expect(text).toContain('**别用重复调上传 / 下载代替**');
    expect(text).toContain('**它自己不启动任何传输**');
  });

  it('names each tool only when that tool is in the snapshot', () => {
    // 锚点在,但其余几个不在(旧版配套插件少给几个):只写真的有的那几条,
    // 绝不点名一个模型调不到的工具 —— 逐条判断是这个模块对配套插件的一贯态度。
    const text = buildIdeGuidanceText([ROOT], {
      tools: { 'ide_list_deployment_servers': {} },
    });
    expect(text).toContain(DEPLOYMENT_HEADING);
    expect(text).toContain('`ide_list_deployment_servers`');
    expect(text).not.toContain('`ide_upload_to_deployment`');
    expect(text).not.toContain('`ide_download_from_deployment`');
    expect(text).not.toContain('`ide_get_deployment_task_status`');
    // 段落之间不留空行就没了 markdown 结构,所以首条 bullet 无论由哪一行给出都得跟段落隔开。
    expect(flat(text)).toContain(flat('不是 IDE 在管的那一份。\n\n- 根项目 `ide_list_deployment_servers`'));
  });

  it('does not turn a run-lifecycle tool into a deployment section', () => {
    const text = buildIdeGuidanceText([ROOT], {
      tools: { 'ide_rerun_run_configuration': {} },
    });
    expect(text).not.toContain(DEPLOYMENT_HEADING);
  });

  it('lists only the projects that actually carry each companion-plugin tool', () => {
    // 这是这一组最要紧的形状:前置条件**按项目、按 IDE** 不同(装没装配套插件;部署那组还要求 Ultimate),
    // 所以"根项目在 IDEA Ultimate、子项目在 PyCharm Community"这种组合下,某个工具可能只有一边有。
    // 列全就会在缺工具的那一边点名一个调不到的命令 —— 而这正是整个模块要防的失败。
    const text = buildIdeGuidanceText([ROOT, CHILD], {
      tools: {
        'modelserver_list_deployment_servers': {},
        'modelserver_upload_to_deployment': {},
        'ide_rerun_run_configuration': {},
      },
    });
    expect(text).toContain('- modelserver `modelserver_upload_to_deployment`');
    expect(text).not.toContain('`ide_upload_to_deployment`');
    expect(text).toContain('- 根项目 `ide_rerun_run_configuration`');
    expect(text).not.toContain('`modelserver_rerun_run_configuration`');
  });

  it('keeps listing every project for the tools the IDE always serves', () => {
    // 只有配套插件那张表需要逐项目核对:内置工具每个项目都有一份,不能因为快照里没有就漏列
    // (快照是本次请求的工具表,而内置工具本来就该全在)。
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools: {} });
    expect(text).toContain(
      '根项目 `ide_search_symbol` ｜ modelserver `modelserver_search_symbol`',
    );
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
