// Merges environment sources and applies them to a shell `create.before`
// invocation.

import path from 'node:path';

/**
 * Merge env sources. Later sources win. `prependPath` entries are collected in
 * order and applied ahead of the existing PATH.
 *
 * @param {Array<{ env?: Record<string, string>, prependPath?: string[] }>} sources
 * @returns {{ env: Record<string, string>, prependPath: string[] }}
 */
export function mergeEnv(sources) {
  const env = {};
  const prependPath = [];
  for (const source of sources) {
    Object.assign(env, source.env ?? {});
    prependPath.push(...(source.prependPath ?? []));
  }
  return { env, prependPath: [...new Set(prependPath)] };
}

/**
 * Apply a merged env to a shell invocation's `env` in place.
 *
 * @param {{ env: Record<string, string | undefined> }} input
 * @param {{ env: Record<string, string>, prependPath: string[] }} merged
 * @param {{ pathKey?: string }} [options]
 */
export function applyEnv(input, merged, options = {}) {
  const pathKey = options.pathKey ?? 'PATH';
  for (const [key, value] of Object.entries(merged.env)) {
    if (value !== undefined) input.env[key] = value;
  }
  if (merged.prependPath.length === 0) return;
  const current = input.env[pathKey] ?? process.env[pathKey] ?? '';
  const parts = [...merged.prependPath, ...current.split(path.delimiter).filter(Boolean)];
  input.env[pathKey] = [...new Set(parts)].join(path.delimiter);
}
