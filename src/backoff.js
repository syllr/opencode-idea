// IDE 连接链路共用的一套退避。
//
// 只回答“第 N 次失败后等多久”，不回答“总共等多久”。每个操作自己用总预算限制：
//
//   probe（后台/显式）    25s
//   prompt 钩子里的 probe 6s
//   open -g 之后等 IDE    60s
//   等工具目录            5s
//
// 之前 probe / 启动 / 工具目录 / 拉起各有一组值（500/1000/2000、5/15/60/120、
// 15/60/180/300…），同一件事在不同路径上节奏不同，busy 还会被套上 120s 的跨消息
// 退避。这里统一成 1s → 2s → 4s，之后固定 4s。

export const RETRY_BACKOFF_MS = [1000, 2000, 4000];

/** 实际拉起 IDE 的最大次数；探测不受这个限制。 */
export const LAUNCH_MAX_ATTEMPTS = 3;

/**
 * 第 `attempt` 次失败后的等待（`attempt` 从 0 开始）。
 *
 * @param {number} attempt
 * @returns {number}
 */
export function retryDelayMs(attempt) {
    const index = Math.min(Math.max(Math.trunc(attempt), 0), RETRY_BACKOFF_MS.length - 1);
    return RETRY_BACKOFF_MS[index];
}
