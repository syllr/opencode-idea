// 把 Markdown 表格重新对齐成仓库的约定:
//
//   * 每一列的**每个单元格**(表头 / 分隔行 / 数据行)显示宽度相同(CJK 算 2 列)
//   * 分隔行 = ' ' + (宽度 - 1) 个 '-'
//   * 内容单元格 = ' ' + 内容 + 补齐到同样宽度的空格
//
// 为什么需要它:IDE 的 Markdown 格式化器会把自己的表格样式写进来
// (`|---|---|`、列宽不按显示宽度对齐),而本仓库的约定是"两个块里的表看起来像一家人",
// 且断言(loader.test.js)守的就是"分隔行点数 = 表头宽度"。
// 流水线因此是:先让 IDE 格式化,再跑这个脚本把表格对齐回去。
//
// 用法:node scripts/align-markdown-tables.js [文件或目录...]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const displayWidth = (text) =>
  [...text].reduce((width, ch) => width + (/[\u2E80-\uFFFF]/.test(ch) ? 2 : 1), 0);

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (line) => /^\s*\|[\s\-:|]+\|\s*$/.test(line);

const splitCells = (line) => {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, trimmed.length - 1);
  return inner.split('|').map((cell) => cell.trim());
};

const buildRow = (contents, widths) =>
  `| ${contents
    .map((content, index) => content + ' '.repeat(Math.max(0, widths[index] - 2 - displayWidth(content))))
    .join(' | ')} |`;

const buildSeparator = (widths) =>
  `| ${widths.map((width) => '-'.repeat(width - 2)).join(' | ')} |`;

/**
 * 对齐一张表。表格是若干连续的 `|` 开头的行。
 *
 * @param {string[]} lines
 * @param {number} start 表格首行下标
 * @returns {string[]} 对齐后的行
 */
const alignTable = (lines, start) => {
  let end = start;
  while (end < lines.length && isTableRow(lines[end])) end += 1;

  const rows = lines.slice(start, end).map(splitCells);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = [];
  for (let column = 0; column < columnCount; column += 1) {
    // 分隔行**不参与**宽度计算:它是"宽度"本身的结果,不是"内容"。
    const longest = Math.max(
      ...rows
        .filter((_, index) => index !== 1)
        .map((row) => displayWidth(row[column] ?? '')),
    );
    widths.push(longest + 2);
  }

  const rebuilt = [];
  rows.forEach((row, index) => {
    if (index === 1) {
      rebuilt.push(buildSeparator(widths));
      return;
    }
    const contents = [];
    for (let column = 0; column < columnCount; column += 1) contents.push(row[column] ?? '');
    rebuilt.push(buildRow(contents, widths));
  });
  return rebuilt;
};

/**
 * 对齐一个文件里的所有表格。
 *
 * @param {string} file
 * @returns {boolean} 文件有没有被改动
 */
export const alignFile = (file) => {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (isTableRow(lines[index]) && isSeparatorRow(lines[index + 1] ?? '')) {
      const table = alignTable(lines, index);
      out.push(...table);
      index += table.length;
      continue;
    }
    out.push(lines[index]);
    index += 1;
  }
  const result = out.join('\n');
  if (result === original) return false;
  writeFileSync(file, result, 'utf8');
  return true;
};

const collect = (target) => {
  const stats = statSync(target);
  if (stats.isFile()) return [target];
  const files = [];
  for (const entry of readdirSync(target)) {
    const child = path.join(target, entry);
    if (statSync(child).isDirectory()) files.push(...collect(child));
    else if (child.endsWith('.md')) files.push(child);
  }
  return files;
};

if (process.argv[1] && process.argv[1].endsWith('align-markdown-tables.js')) {
  const targets = process.argv.slice(2);
  const files = (targets.length ? targets : ['skills']).flatMap(collect);
  let changed = 0;
  for (const file of files) {
    if (alignFile(file)) {
      changed += 1;
      console.log(`aligned ${file}`);
    }
  }
  console.log(`${changed} file(s) changed, ${files.length} scanned`);
}
