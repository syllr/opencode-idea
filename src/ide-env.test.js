import { describe, expect, it } from 'vitest';
import { extractSdkEnv, parseCommandOutput, parsePrintenv } from './ide-env.js';

describe('parsePrintenv', () => {
  it('parses KEY=VALUE lines, preserves = in values, skips noise', () => {
    const env = parsePrintenv('JAVA_HOME=/jdk\nFOO=a=b\nnot a line\n\nPATH=/bin');
    expect(env).toEqual({ JAVA_HOME: '/jdk', FOO: 'a=b', PATH: '/bin' });
  });
});

describe('parseCommandOutput', () => {
  it('unwraps the execute_terminal_command JSON payload', () => {
    const payload = JSON.stringify({ command_exit_code: 0, command_output: 'JAVA_HOME=/jdk\n' });
    expect(parseCommandOutput(payload)).toEqual({ JAVA_HOME: '/jdk' });
  });

  it('falls back to raw printenv text', () => {
    expect(parseCommandOutput('JAVA_HOME=/jdk')).toEqual({ JAVA_HOME: '/jdk' });
  });
});

describe('extractSdkEnv', () => {
  it('keeps only SDK-related keys', () => {
    const env = extractSdkEnv({ JAVA_HOME: '/jdk', HOME: '/home', FOO: 'bar', GOROOT: '/go' });
    expect(env).toEqual({ JAVA_HOME: '/jdk', GOROOT: '/go' });
  });
});
