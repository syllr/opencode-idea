import { describe, expect, it, vi } from 'vitest';
import { extractSdkEnv, parseCommandOutput, parsePrintenv, readIdeTerminalEnv } from './ide-env.js';

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

describe('readIdeTerminalEnv', () => {
  it('passes the injected fetch implementation to the Streamable-HTTP client', async () => {
    const replies = [
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: JSON.stringify({ command_output: 'JAVA_HOME=/jdk\n' }) }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ];
    const fetchImpl = vi.fn(async () => replies.shift());
    await expect(readIdeTerminalEnv(1234, '/project', fetchImpl)).resolves.toEqual({ JAVA_HOME: '/jdk' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('extractSdkEnv', () => {
  it('keeps only SDK-related keys', () => {
    const env = extractSdkEnv({ JAVA_HOME: '/jdk', HOME: '/home', FOO: 'bar', GOROOT: '/go' });
    expect(env).toEqual({ JAVA_HOME: '/jdk', GOROOT: '/go' });
  });
});
