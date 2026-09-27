// Pure helpers for locating the current OpenCode project.

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
