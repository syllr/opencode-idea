// Pure helpers for locating the current OpenCode project.

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the absolute project root for the current plugin location.
 * OpenCode exposes a `Location.Info` on the plugin context.
 *
 * @param {{ directory?: string, project?: { directory?: string } } | undefined} location
 * @returns {string | undefined}
 */
export function currentProjectPath(location) {
  if (!location) return undefined;
  const projectDirectory = location.project && location.project.directory;
  return projectDirectory || location.directory || undefined;
}

/**
 * True when the directory looks like a JetBrains project (has a `.idea` folder).
 * This is a convenience signal only; the plugin does not require it, because an
 * IDE may have created the project entry without writing `.idea` yet.
 *
 * @param {string | undefined} directory
 * @returns {boolean}
 */
export function hasIdeaDirectory(directory) {
  return typeof directory === 'string' && existsSync(path.join(directory, '.idea'));
}
