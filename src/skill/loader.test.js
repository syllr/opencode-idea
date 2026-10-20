import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readAutoinvoke, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';
import { HIDDEN_IDE_TOOL_SUFFIXES } from '../plugin.js';

const TEMPLATE = path.join(path.dirname(readSkill('idea-standalone').path), 'assets/AGENTS.template.md');

/** Read the skeleton the skill must consult before writing anything. */
const readTemplate = () => readFileSync(TEMPLATE, 'utf8');

/**
 * Read the catalog skeleton the manager skill writes its table into. It shares
 * one `AGENTS.md` with the standalone block, so the two are read together.
 *
 * @returns {string}
 */
const managerTemplate = () =>
  readFileSync(
    path.join(path.dirname(readSkill('idea-run-config-manager').path), 'assets/AGENTS.template.md'),
    'utf8',
  );

/**
 * 折叠空白:模板会被 Markdown 格式化工具重排(缩进 2→4、括号前插空格、长行折行),
 * 所以断言只关心内容,不关心排版 —— 否则每次格式化都会红一片。
 *
 * @param {string} text
 */
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * 去掉**所有**空白再比。
 *
 * `squash` 只能折叠空白,吸收不了格式化工具**插入**的空格(它在中文与括号之间会加一个)。
 * 断言的是"这几段字在不在",排版怎么变都不该让它红,所以这层比 `squash` 更狠。
 *
 * @param {string} text
 */
const tight = (text) => text.replace(/\s+/g, '');

/** 条目产物区(生成提示删掉之后要留下的那部分)。 */
const managerProduct = () => {
  const text = managerTemplate();
  const start = text.indexOf('### base 登记');
  const end = text.indexOf('## 用户手动触发');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

/** 产物区里出现过的条目项名(按出现顺序去重,排版无关)。 */
const managerItemNames = () => [
  ...new Set([...managerProduct().matchAll(/^[ \t]*- ([^\n:]+):/gm)].map((match) => match[1].trim())),
];

/**
 * A skill file as written. The frontmatter is metadata: it decides how the skill
 * is registered but is never part of the registered definition, so proving what
 * the author wrote means reading the raw file.
 *
 * @param {string} file Absolute path to a `SKILL.md`.
 */
const rawFrontmatter = (file) => readFileSync(file, 'utf8');

describe('shipped skills', () => {
  it('writes frontmatter a real YAML reader can parse', () => {
    // Our own reader is deliberately flat and lenient — `unquote` just drops the
    // first and last character. OpenCode has a real YAML parser on the path taken
    // when a user points `skills` at one of these directories (or copies it into
    // `.opencode/skills`). A double-quoted scalar containing an unescaped `"` ends
    // the string early there and the whole file becomes unreadable, which is
    // exactly how `idea-run-config-manager` broke once. Keep the two gates apart:
    // the lenient one proves registration, this one proves portability.
    for (const { skill } of readSkills()) {
      const frontmatter = rawFrontmatter(skill.path).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1];
      expect(frontmatter, `${skill.id}: no frontmatter`).toBeTruthy();
      for (const line of frontmatter.split('\n')) {
        const match = /^([A-Za-z0-9_/-]+):[ \t]*(.*)$/.exec(line.trim());
        if (!match) continue;
        const value = match[2].trim();
        if (value.startsWith('"') || value.endsWith('"')) {
          // Quoted scalars must be closed on the same line, and nothing unescaped
          // may follow the closing quote.
          expect(value.length >= 2 && value.startsWith('"') && value.endsWith('"'), `${skill.id}: ${line}`).toBe(true);
          expect(value.slice(1, -1), `${skill.id}: unescaped quote inside a double-quoted value`).not.toContain('"');
        }
      }
    }
  });

  it('loads every skill directory into a Skill.Info-shaped definition', () => {
    /** 每个 skill 注册时带的键 —— 一项不多(没有 requires 之类的自有元数据)。 */
    const skillKeys = ['content', 'description', 'id', 'name', 'path'];
    const skills = readSkills();
    // Sorted by id, so the order is stable across runs.
    expect(skills.map(({ skill }) => skill.id)).toEqual(['idea-run-config-manager', 'idea-standalone']);
    // No gating metadata: the package used to carry a `requires:` key that the
    // plugin filtered on, which is exactly what delayed registration until after
    // `/open-in-ide` (and left the skill invisible until a page reload). A skill
    // is now just a directory with a document in it.
    for (const { skill } of skills) {
      expect(Object.keys(skill)).not.toContain('requires');
      // Only `Skill.Info` keys (`autoinvoke` only where the frontmatter asks).
      expect(Object.keys(skill).filter((key) => !skillKeys.includes(key))).toEqual(
        skill.autoinvoke === undefined ? [] : ['autoinvoke'],
      );
    }

    const skill = readSkill('idea-standalone');
    // `Skill.Info` requires exactly these keys (see @opencode/schema/skill):
    // `id` / `name` / `description?` / `autoinvoke?` / `path` / `content`.
    expect(Object.keys(skill).sort()).toEqual(['content', 'description', 'id', 'name', 'path']);
    expect(skill.name).toBe('idea-standalone');

    // `path` must be an absolute path to a file that really ships.
    expect(skill.path.startsWith('/')).toBe(true);
    expect(skill.path.endsWith(SKILL_FILE_NAME)).toBe(true);
    expect(existsSync(skill.path)).toBe(true);

    // The frontmatter is metadata: it must never leak into the model prompt.
    expect(skill.content.startsWith('# ')).toBe(true);
    expect(skill.content.startsWith('---')).toBe(false);
  });

  it('makes the manager user-invoked only, through the portable frontmatter', () => {
    // `opencode/autoinvoke: false` is OpenCode's own switch: the skill stays
    // registered and loadable by ID, but is left out of the model's available
    // list — so only the user can bring it in (`@idea-run-config-manager`).
    // Frontmatter is not registered, so the loader has to translate it onto the
    // definition under the name the registration API uses.
    const skill = readSkill('idea-run-config-manager');
    expect(skill.autoinvoke).toBe(false);
    // Same exact key set as `Skill.Info` allows — no stray field rides along.
    expect(Object.keys(skill).sort()).toEqual(['autoinvoke', 'content', 'description', 'id', 'name', 'path']);
    expect(rawFrontmatter(skill.path)).toContain('metadata:\n  opencode/autoinvoke: false');

    // The standalone skill says nothing, so it keeps the plain shape and stays
    // model-invocable.
    expect(readSkill('idea-standalone').autoinvoke).toBeUndefined();
  });

  it('flattens the nested autoinvoke block and rejects other values', () => {
    // One nesting level is supported on purpose: the reader is flat, so the
    // indented line has to land under the namespaced key by itself, and the bare
    // `metadata:` line comes out empty. This is the shape OpenCode documents.
    expect(
      parseSkillFrontmatter('---\nname: x\nmetadata:\n  opencode/autoinvoke: false\n---\nbody', 'x'),
    ).toEqual({ name: 'x', metadata: '', 'opencode/autoinvoke': 'false' });
    expect(readAutoinvoke({}, 'x')).toBeUndefined();
    expect(readAutoinvoke({ 'opencode/autoinvoke': 'true' }, 'x')).toBe(true);
    // A typo must not quietly leave a skill model-invocable — that is exactly the
    // failure the switch exists to prevent.
    expect(() => readAutoinvoke({ 'opencode/autoinvoke': 'no' }, 'x')).toThrow(/true or false/);
  });

  it('edits configuration files through a per-type template, never from memory', () => {
    // `idea-run-config` was removed because of its METHOD: hand-authoring
    // 手写配置文件是 fragile path —— a wrong `type` makes the
    // IDE ignore the whole file, silently, with nothing in the log.
    // `idea-run-config-manager` takes the subject over and keeps exactly that
    // guard rail while doing the work itself: the model DOES edit those files,
    // because the skill is user-invoked — but only by copying a template whose
    // every field came from a real file, and only for types that have one. No
    // template means the configuration goes to the user instead.
    expect(readSkills().map(({ skill }) => skill.id)).not.toContain('idea-run-config');
    expect(() => readSkill('idea-run-config')).toThrow();

    const manager = readSkill('idea-run-config-manager').content;
    expect(manager).toContain('直接动手');
    // 提示词里**不出现**配置文件路径 —— 提了模型就会去手写文件。
    expect(manager).not.toContain('.run/');
    expect(manager).toContain('支持矩阵');
    expect(manager).toContain('assets/types/');
    expect(tight(manager)).toContain(tight('走工具,不要自己写文件'));
    // Writing the file is only half of it: an unnoticed file is worse than none,
    // so the catalog has to prove it was picked up.
    expect(manager).toContain('写完必须复查');
    // And a type without a template is not a reason to guess.
    expect(manager).toContain('交给用户');
  });

  it('ships one template per configuration type it verified', () => {
    // The whole reason a wrong `type` fails silently is that nobody knows the ids.
    // So every type the skill writes must be named in the matrix with its real id,
    // and every template must carry the envelope and the trailing `<method v="2" />`
    // that a real file has — a template missing them teaches a file the IDE ignores.
    const skill = readSkill('idea-run-config-manager');
    const manager = skill.content;
    const types = path.join(path.dirname(skill.path), 'assets/types');

    for (const id of [
      'ShConfigurationType',
      'MavenRunConfiguration',
      'GradleRunConfiguration',
      'js.build_tools.npm',
      'PythonConfigurationType',
      'GoApplicationRunConfiguration',
      'NodeJSConfigurationType',
    ]) {
      expect(manager, id).toContain(id);
    }
    // Types whose fields were never verified against a real file stay unwritten
    // rather than guessed, and the matrix says so.
    expect(manager).toContain('Application');
    expect(manager).toContain('JarApplication');
    expect(manager).toContain('⏳');
    // The matrix and the contract live in the skill itself: what may be written
    // is one thing to read, not a pointer chasing another document.
    expect(tight(manager)).toContain(tight('## 硬性契约(所有类型都一样)'));
    // Templates are added by us, not invented on the spot: teaching the model
    // how to author one is how a guessed field name gets into a template.
    expect(manager).not.toContain('Store as project file');

    for (const file of ['shell.md', 'maven.md', 'gradle.md', 'npm.md', 'python.md', 'go-build.md', 'node.md']) {
      const template = readFileSync(path.join(types, file), 'utf8');
      expect(template, file).toContain('ProjectRunConfigurationManager');
      expect(template, file).toContain('method v="2"');
      // Its own type id, so a template can never be applied to another type.
      const row = manager.split('\n').find((line) => line.includes(`](assets/types/${file})`));
      expect(row, `矩阵里没有 ${file}`).toBeTruthy();
      expect(template, file).toContain(row.split('|')[2].trim());
    }
  });

  it('records the project catalog as its own marked block', () => {
    // Same shape as idea-standalone, different subject: this block is the
    // catalog — one line per configuration, so the next session finds an existing
    // one instead of building a duplicate. It has to state the ownership of that
    // block too, or an update would trample its neighbours.
    const skill = readSkill('idea-run-config-manager');
    expect(skill.content).toContain('项目根 `AGENTS.md`');
    expect(skill.content).toContain('<!-- idea-run-config-manager:begin -->');
    expect(skill.content).toContain('<!-- idea-run-config-manager:end -->');
    expect(skill.content).toContain('不要触碰');
    // The skeleton lives in the template, so the skill's job is to point at it.
    expect(skill.content).toContain('assets/AGENTS.template.md');
  });

  it('syncs the catalog on every change, whoever made it', () => {
    // The point of the block is that it matches the project. A configuration
    // created, removed or edited — by the model or by the user in the IDE — must
    // land in the catalog in the same breath, or it starts lying to whoever
    // reads it next.
    const content = readSkill('idea-run-config-manager').content;
    expect(content).toContain('联动是硬要求');
    expect(content).toContain('加条目 / 删条目 / 改条目');
    expect(content).toContain('无论那次改动是谁做的');
  });

  it('keeps the manager template to one section per platform', () => {
    const skill = readSkill('idea-run-config-manager');
    const template = readFileSync(path.join(path.dirname(skill.path), 'assets/AGENTS.template.md'), 'utf8');

    // Same wrapper the produced block uses, so a diff of the two is meaningful.
    expect(template.startsWith('<!-- idea-run-config-manager:begin -->')).toBe(true);
    expect(template.trimEnd().endsWith('<!-- idea-run-config-manager:end -->')).toBe(true);

    // Two sections, one per platform — the same split idea-standalone uses. A flow is
    // often not the same command on both, so "which platform" is a property of the
    // entry rather than something a reader has to infer from the command.
    const headings = template
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => line.replace(/\s+/g, ''));
    expect(headings).toEqual([
      '#runconfiguration档案',
      '##runconfiguration一览',
      '###base登记',
      '##用户手动触发(线下,AI不跑)',
    ]);
    // 平台与环境由**名字里的段**决定(`[os@]base[@env]`),所以本块只登记 base,
    // 变体不另起条目 —— 要把"有哪些变体、怎么切环境"写进 base 的 desc。
    expect(squash(template)).toContain('[os@]base[@env]');
    expect(squash(template)).toContain('只登记 base');
    expect(squash(template)).toContain('判断不了就问用户');

    // One entry answers the only question the catalog is for: what is this
    // configuration, which project's tools address it, and how do I run it.
    // An entry, NOT a table row: a table's cells have to be padded to stay aligned
    // once they hold prose, and that padding is what an editing tool eats first.
    // 标题行:配置名 + 项目(排版无关)。两节各一条,末尾手动那节再一条。
    const titles = managerProduct().match(/^-[ \t]*\{配置名\}/gm) ?? [];
    expect(titles).toHaveLength(1);
    expect(squash(template)).toContain('- {配置名} (项目 {前缀})');
    expect(template).not.toContain('| 项目 |');
    // 五项按模板固定的顺序出现在产物区。
    expect(managerItemNames()).toEqual(['when', 'before run', 'run', 'after run', 'desc']);

    // The "when" item carries the trigger, the "before it" item the prerequisites —
    // usually not a configuration of their own, so those items are the only place
    // they can be written down.
    expect(template).toContain('**when**');
    // when names WHO may start it, and that question has three answers. Only two
    // live in the list: a manually-started configuration is never run by the model,
    // so it gets its own section with nothing but names.
    for (const mode of ['用户手动触发', '用户授权触发', 'AI 自己触发']) {
      expect(template).toContain(mode);
    }
    expect(template).toContain('{用户授权触发 / AI 自己触发}');
    expect(template).toContain('必须把场景写具体');
    // 默认形态是"一条一行":简单条目不该被拆成一堆子项。
    for (const line of [
      '  - when:{用户授权触发 / AI 自己触发} —— {什么场景}',
      '  - before run:{第 1 步 / 第 2 步 / 无}',
      '  - run:{<前缀>_execute_run_configuration}',
      '  - after run:{产物落在哪 / 接下来要做什么 / 无}',
      '  - desc:{它是什么 + 有什么坑 + 有哪些 @ 变体、各自怎么切环境}',
    ]) {
      expect(template).toContain(line);
    }
    // 两种形态并存,而且是**逐项**判断:同一条可以一部分行内、一部分子列表。
    // 这条判据必须写在模板里,否则复杂条目会被压成一行、简单条目又会被拆散。
    expect(template).toContain('每一项都有两种写法,逐项判断');
    expect(template).toContain('混着两种写法是常态');
    expect(template).toContain('全子列表');
    expect(template).toContain('全行内');
    // 两种形态各给一份可照抄的例子,否则"什么时候拆"仍然只能靠猜。
    expect(template).toContain('- `connector-build`(项目 ide)');
    expect(template).toContain('- `db-migrate`(项目 ide)');
    // The product text explains the three modes instead of listing the items: the
    // reader has to know when it may act, and the item names already say what they
    // hold.
    expect(template).toContain('谁能起它,只有三种');
    expect(template).not.toContain('下面四项固定');
    expect(template).toContain('**before run**');
    expect(template).toContain('跑之前要先做的事');
    // `after run` answers the other half of that: what the run leaves behind.
    expect(template).toContain('**after run**');
    expect(template).toContain('跑完之后的结果');

    // The manual section is a name list: no items at all, because nothing in it is
    // ever launched by the model.
    const manual = template.slice(template.indexOf('## 用户手动触发'));
    expect(squash(manual)).toContain('- {配置名} (项目 {前缀})');
    expect(manual).not.toMatch(/^[ \t]*- run:/m);

    // Resident / service-like configurations belong to idea-standalone and are
    // filtered out first, so the two blocks never document the same one. The
    // filter reads that block rather than guessing which name looks resident.
    expect(template).toContain('先过滤');
    expect(template).toContain('这些一律不进本块');
    expect(template).toContain('`idea-standalone` 的标记块');
    // The app table (ports, hot reload) stays over there, and stays a table.
    expect(template).not.toContain('| 应用 | run configuration | 怎么跑 | 端口 |');

    // Configurations are addressed through the prefixed MCP tools, so the block
    // names no IDE application: the prefix is what says whose configuration it is.
    expect(template).not.toContain('IDEA');
    expect(template).toContain('子项目是它的目录名');

    // Per-section guidance lives in the template, and the instructions for the
    // generating step must not survive into the produced block.
    expect(template).toContain('<!-- 生成提示:begin -->');
    expect(template).toContain('产物里整块删掉');
    expect(skill.content).toContain('产物里整块删掉');
    // The split is deliberate: SKILL.md is the flow, and every rule about what to
    // write where lives in this template's generation guidance. The skill has to
    // say so, or a later edit will start duplicating the rules back into it.
    expect(skill.content).toContain('都在那份模板的生成提示里');
    expect(tight(template)).toContain(tight('看它的内容'));
    expect(template).toContain('它会起出重复实例');
    // The template carries metavariables; it also carries the rule that none of
    // them may survive into the produced block.
    expect(template).toContain('{...}');
    expect(template).toContain('不留进产物');
  });

  it('keeps the manager off hand-rolled start-up commands', () => {
    // Editing a configuration file is allowed here; replacing a configuration
    // with a bare command line is not. A Shell Script config exists precisely so
    // the run has a home in the IDE, so substituting `pnpm dev` for it would
    // undo the whole thing. Listing configurations is a tool call too.
    const content = readSkill('idea-run-config-manager').content;
    expect(content).toContain('直接调用,不传参数');
    expect(tight(content)).toContain(tight('逐个项目用**它自己那个前缀**'));
    expect(content).toContain('不要手搓启动命令');
  });

  it('keeps the standalone skill teaching the four-part rule', () => {
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('<前缀>_get_run_configurations');
    expect(content).toContain('standalone');
    expect(content).toContain('热重载');
    // The skeleton lives in the template, so the skill's job is to point at it.
    expect(content).toContain('assets/AGENTS.template.md');
  });

  it('starts and stops apps through rerun/stop, never execute_run_configuration', () => {
    // `execute_run_configuration` runs the "Run" path: on a long-running config it
    // spawns a SECOND process instead of restarting the first. It belongs to
    // command/job configurations. Apps in standalone mode are the long-running
    // kind, so they go through rerun/stop.
    // Exactly one tool runs these apps. Start vs restart is not a distinction the
    // model should have to make — rerun covers both, so the rule says so once.
    expect(readTemplate()).toContain('**跑应用只用 `<前缀>_rerun_run_configuration`**');
    expect(readTemplate()).toContain('不必分辨"这是启动还是重启"');
    expect(readTemplate()).toContain('**命令 / Job 类型**');
    // Nothing else is offered as a way to run or stop them here.
    expect(readTemplate()).not.toContain('<前缀>_stop_run_configuration');
    expect(readTemplate()).not.toContain('<前缀>_list_running_configurations');
    // And the prohibition must be stated, not just implied.
    expect(readTemplate()).toContain('不要用 `<前缀>_execute_run_configuration` 跑这些应用');
  });

  it('pins the entry point, not the shape, of how an app runs', () => {
    // A run configuration may start a local process, a container, or deploy to a
    // remote host. The discipline is about the ONE entry point, so claiming the
    // app must run as a local process would be both wrong and restrictive.
    const template = readTemplate();
    expect(template).toContain('**standalone = 启动收口只有 IDEA run configuration**');
    expect(template).toContain('入口唯一');
    expect(template).toContain('形态不限');
    expect(template).toContain('容器');
    expect(template).toContain('部署到远端');
    for (const absolute of ['本机进程直跑', '不容器化', '不部署到远端']) {
      expect(template, absolute).not.toContain(absolute);
    }
  });

  it('gives every config table a how-to-run and a before-it column', () => {
    // Some configurations assume something was done first (deps installed, built,
    // a dependency service up). That something is usually not itself a run
    // configuration, so the only place to say it is prose in this column.
    const template = readTemplate();
    expect(tight(template)).toContain(
      tight('| app | run configuration | before run | run | port | after run | desc |'),
    );
    expect(template).toContain('**before run**');
    // A service is run, not just named: how it is run belongs in the table too,
    // or the reader has to go looking for the rule somewhere else.
    expect(template).toContain('**run**');
    expect(template).toContain('rerun');
    // Usually empty, and ordered steps when not.
    expect(tight(template)).toContain(tight('多数应用写 `无`'));
    expect(template).toContain('按顺序写清第 1 步、第 2 步、第 3 步');
    // `after run` carries what the run leaves behind — for a resident app that is
    // mostly "which port it listens on" (its own column) and nothing else, so the
    // rule says most rows leave it empty.
    expect(template).toContain('**after run**');
    expect(tight(template)).toContain(tight('多数写 `无`'));
    // No "when" column here: a resident app is started when you want to test a
    // change, so there is no other moment to name. (The archive keeps one — a
    // build or a migration does happen at a particular time.)
    expect(template).not.toContain('| when |');
  });

  it('shares four item names with the app table', () => {
    // Both blocks end up in the same shared `AGENTS.md` and answer the same core
    // questions, so they use the same short keys — `run` / `before run` /
    // `after run` / `desc`. Each block adds only what it alone has: the app table
    // `app` / `run configuration` / `port`, the archive `when` (a resident app is
    // started when you want to test a change, so there is no other moment to name).
    // The SHAPES still differ on purpose — the app table stays a table, the manager
    // block is a list of entries — so this is name/order equality, not width.
    const rowOf = (text, startsWith) =>
      text.split('\n').find((line) => line.startsWith(startsWith));
    const cellsOf = (row) => row.split('|').slice(1, -1).map((cell) => cell.trim());
    /** 条目项的项名（`  - before run:…` 的那一段）。 */
    const itemNames = (text) =>
      text
        .split('\n')
        .filter((line) => /^ {2}- [^:]+:/.test(line))
        .map((line) => line.slice(4, line.indexOf(':')));

    const standalone = cellsOf(
      readTemplate()
        .split('\n')
        .find((line) => line.trim().startsWith('|') && cellsOf(line)[0] === 'app'),
    );
    expect(standalone[0]).toBe('app');
    // A service has a port; a fixed flow is not a service and has no such field.
    expect(standalone).toContain('port');
    expect(standalone).not.toContain('when');

    const manager = managerTemplate();
    const managerFields = managerItemNames();
    expect(managerFields).toEqual(['when', 'before run', 'run', 'after run', 'desc']);
    expect(managerFields).not.toContain('port');

    // The four shared names appear in both, in the same relative order — the app
    // table's own columns may sit between them, which is why only these four line up.
    const shared = ['before run', 'run', 'after run', 'desc'];
    const positions = shared.map((name) => standalone.indexOf(name));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(managerFields.filter((name) => shared.includes(name))).toEqual(shared);

    // Both templates say the same thing about the contract, so neither can drift
    // into "these blocks are unrelated" unnoticed.
    for (const text of [manager, readTemplate()]) {
      expect(text).toContain('同名同序');
    }

    // Widths follow one convention inside that block (a CJK glyph is two wide,
    // ASCII is one), so a separator cell always has exactly as many dashes as its
    // header is wide. That is what keeps its two tables looking like one family
    // without padding, and it is why an editor that normalises spaces cannot break
    // the alignment.
    const displayWidth = (text) =>
      [...text].reduce((width, ch) => width + (/[⺀-￯]/.test(ch) ? 2 : 1), 0);
    // 表头行按**首格**认,不按整行字面 —— 列宽会随内容变,行首不再恰好是 '| app |'。
    const tablesOf = (text, firstCell) =>
      text
        .split('\n')
        .map((line, index, lines) => [line, lines[index + 1]])
        .filter(([line]) => line.trim().startsWith('|') && cellsOf(line)[0] === firstCell)
        .map(([line, separator]) => [cellsOf(line), cellsOf(separator)]);
    const tables = tablesOf(readTemplate(), 'app');
    expect(tables.length, '应用表的表头后面没有分隔行').toBeGreaterThan(0);
    for (const [header, separator] of tables) {
      expect(separator.map((cell) => cell.length)).toEqual(header.map(displayWidth));
    }
  });

  it('registers only the base and explains the @-variants', () => {
    // 平台与环境的差异由**配置名里的段**承担(`[os@]base[@env]`),所以两个块都只登记 base,
    // 变体不另起条目、也不另起表 —— 否则同一个应用会因为"几个平台 × 几个环境"膨胀出
    // 十几行,而它们其实是同一件事。
    const template = readTemplate();
    expect(squash(template)).toContain(squash('[os@]base[@env]'));
    expect(squash(template)).toContain(squash('表里只登记 base'));
    // 名字怎么读、变种怎么选,各占一节,且**排在表前面** —— 规则先讲清楚,表才有意义。
    expect(template).toContain('### run configuration 名字怎么读');
    expect(template).toContain('### 应用');
    expect(template).toContain('### 选哪个变种');
    expect(template.indexOf('### run configuration 名字怎么读')).toBeLessThan(template.indexOf('### 应用'));
    // 缺省:没有系统段 = macOS / Linux;没有环境段 = 所有环境通用这一套。
    expect(squash(template)).toContain(squash('缺省表示'));
    // 选变种的纪律:问一次就够,别反复打扰用户。
    expect(squash(template)).toContain(squash('启动前问一次用户走哪套'));
    expect(squash(template)).toContain(squash('本会话内默认走这一套'));
    // Exactly one app table now — the variants are not rows of their own.
    const header = '| app | run configuration | before run | run | port | after run | desc |';
    expect(tight(template).split(tight(header))).toHaveLength(2);

    // Same on the other side — a section instead of a table, and the entries are
    // base entries.
    const manager = managerTemplate();
    expect(squash(manager)).toContain(squash('只登记 base'));
    expect(manager).toContain('### base 登记');
    // 产物区(生成提示删掉之后要留下的那部分)是条目式,不是表格;
    // 生成提示里允许出现说明用的表格,它不会进产物。
    const product = manager.slice(manager.indexOf('### base 登记'), manager.indexOf('## 用户手动触发'));
    expect(product).not.toContain('|');
  });

  it('restarts without asking, so the loop stays unattended', () => {
    // The point of routing restarts through the tool is that nobody has to be
    // there. A consent step would put a human back in the loop.
    for (const source of [readSkill('idea-standalone').content, readTemplate()]) {
      expect(source).not.toContain('先取得用户明确授权');
      expect(source).not.toContain('取得明确授权');
      // The old blanket prohibition is gone, so nothing may still refer to it.
      expect(source).not.toContain('不得代为启停');
      expect(source).not.toContain('standalone 的禁令');
    }
    expect(readTemplate()).toContain('重启不必先问');
    expect(readTemplate()).toContain('无人化');
  });

  it('writes into the project AGENTS.md as a marked block, not a rule file', () => {
    // Root AGENTS.md is what the AI reads for this project anyway, so the rule
    // needs no separate file and no always-apply switch. The markers are what
    // makes a later update detectable and keeps the skill off everything else
    // in that shared file.
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('项目根 `AGENTS.md`');
    expect(content).toContain('<!-- idea-standalone:begin -->');
    expect(content).toContain('<!-- idea-standalone:end -->');
    expect(content).not.toContain('.opencode/rules/idea-standalone.md');
    expect(content).not.toContain('alwaysApply');
  });

  it('builds a missing configuration through the tool, after asking, never by hand', () => {
    // A missing configuration is not the model's to author silently: it asks the
    // user first (a run configuration is a durable project artefact), then builds
    // it through the tool — never by writing the file itself.
    const content = readSkill('idea-standalone').content;
    expect(tight(content)).toContain(tight('先问用户要不要建'));
    expect(tight(content)).toContain(tight('create_run_configuration'));
    expect(tight(content)).toContain(tight('也不要自己写配置文件'));

    // The block written into a project's AGENTS.md routes the same way, so the
    // rule survives into the file an AI reads on its own next time.
    expect(tight(readTemplate())).toContain(tight('create_run_configuration'));
  });

  it('ships the skeleton as a template the skill must read first', () => {
    const skill = readSkill('idea-standalone');
    // The loader documents the skill directory as the base for its own assets,
    // so resolve the template exactly the way a reader of the skill would.
    const template = readFileSync(path.join(path.dirname(skill.path), 'assets/AGENTS.template.md'), 'utf8');

    // Same wrapper the produced block uses, so a diff of the two is meaningful.
    expect(template.startsWith('<!-- idea-standalone:begin -->')).toBe(true);
    expect(template.trimEnd().endsWith('<!-- idea-standalone:end -->')).toBe(true);

    // Every heading is one level deeper than its parent (`#` block title, `##`
    // sections, `###` the per-platform sub-tables), and the parts are numbered in
    // order. Both halves matter: a lost section is invisible otherwise, and a
    // level slip silently changes how the block nests inside the host AGENTS.md.
    // 排版归格式化工具管(它会在括号前插空格、折长行),所以比的是**级别与顺序**,不是字面:
    // 两边都去掉所有空白再比。
    const headings = template.split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => line.replace(/\s+/g, ''));
    expect(headings).toEqual([
      '# Standalone 模式纪律',
      '## 一、什么是 standalone 模式',
      '## 二、standalone 下启动哪些应用(必须经 IDEA run configuration)',
      '### run configuration 名字怎么读',
      '### 应用',
      '### 选哪个变种(启动前必须做对)',
      '## 三、热重载矩阵:改代码后要不要提醒重启',
    ].map((heading) => heading.replace(/\s+/g, '')));

    // Per-section guidance lives in the template, not in the skill.
    expect(template).toContain('<!-- 生成提示:begin -->');
    // The produced file is read by AIs as rules, so the instructions for the
    // generating step must not survive into it.
    expect(template).toContain('产物里整块删掉');
    expect(readSkill('idea-standalone').content).toContain('产物里整块删掉');
    expect(template).toContain('<前缀>_get_run_configurations');
    // The template carries metavariables; it also carries the rule that none of
    // them may survive into the produced block.
    expect(template).toContain('{...}');
    expect(template).toContain('不留进产物');
  });

  it('reads the configurations from the tool, not by reading files', () => {
    // `<前缀>_get_run_configurations` called with no arguments answers exactly the
    // question this skill asks: the configurations the USER has already set up,
    // launch details included. Reading the configuration files one by one
    // would re-derive what that call already returns.
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('直接调用,不传任何参数');
    expect(tight(content)).toContain(tight('用户已经在 IDEA 里配好的那些'));
    expect(tight(content)).toContain(tight('不需要再去项目目录里逐个翻配置文件'));
  });

  it('references no tool that the plugin hides from the model', () => {
    // Hidden tools are stripped from every request, so a skill that names one is
    // telling the model to call something it cannot see. The hidden list is held
    // as SUFFIXES (the real name carries a per-project prefix), which is also how
    // a skill refers to a tool here.
    const content = readSkill('idea-standalone').content;
    for (const suffix of HIDDEN_IDE_TOOL_SUFFIXES) {
      expect(content, `${suffix} 已被隐藏`).not.toContain(suffix);
    }
  });

  it('fails loudly when a SKILL.md has no usable metadata', () => {
    expect(() => parseSkillFrontmatter('# no frontmatter here', 'skills/x/SKILL.md')).toThrow(/frontmatter/);
    // `readSkill` is what requires a description; every shipped skill must have
    // one, otherwise OpenCode never offers it to the model.
    expect(readSkills().every(({ skill }) => skill.description.length > 0)).toBe(true);
  });

  it('reads quoted and bare values without a YAML engine', () => {
    expect(
      parseSkillFrontmatter('---\nname: acme\ndescription: "uses: colons, fine"\n---\nbody', 'x'),
    ).toEqual({ name: 'acme', description: 'uses: colons, fine' });
    expect(parseSkillFrontmatter("---\nname: 'acme'\n---\nbody", 'x')).toEqual({ name: 'acme' });
  });
});
