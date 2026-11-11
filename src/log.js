// 插件的最小日志。
//
// 存在的理由只有一个：IDE 连接出问题时，之前**一行日志都没有** —— 探测失败、拉起
// 失败、放弃重连全被 `catch {}` 吞掉，线上只能靠 OpenCode 自己的日志倒推，而插件自己
// 打的 HTTP 探测它根本看不见。排查一次「有标记却没连上」要翻三个日志文件才拼出时间线。
//
// 只打**状态变化**和**失败**，不打每次成功的常规动作：一个会话里的探测会重复很多次，
// 全打出来只会把日志淹掉。
//
// 走 `console.warn` 而不是 `console.log`：OpenCode 会把插件的普通 stdout 当噪音过滤，
// stderr 会留在终端/服务日志里。

const PREFIX = '[opencode-idea]';

/**
 * 打一条带固定前缀的结构化日志。
 *
 * @param {string} event 事件名（`ide.probe` / `ide.launch` / `ide.give-up` …）
 * @param {Record<string, unknown>} [fields] 附加字段，值会按 `key=value` 拼接
 */
export function logEvent(event, fields = {}) {
    // 测试里静音：跑 `npm test` 时这些行只会把失败信息淹掉。测试自己会临时清掉这个
    // 变量来验证日志真的打出来了。
    if (process.env.VITEST) return;
    const parts = [PREFIX, event];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === '') continue;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        parts.push(`${key}=${text}`);
    }
    try {
        console.warn(parts.join(' '));
    } catch {
        // 记日志永远不能把插件弄挂
    }
}
