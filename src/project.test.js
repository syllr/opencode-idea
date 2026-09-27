import { describe, expect, it } from 'vitest';
import { currentProjectPath } from './project.js';

describe('currentProjectPath', () => {
  it('prefers the project directory', () => {
    expect(currentProjectPath({ directory: '/work', project: { directory: '/project' } })).toBe('/project');
  });

  it('falls back to the location directory', () => {
    expect(currentProjectPath({ directory: '/work' })).toBe('/work');
  });

  it('returns undefined for empty input', () => {
    expect(currentProjectPath(undefined)).toBeUndefined();
    expect(currentProjectPath({})).toBeUndefined();
  });
});
