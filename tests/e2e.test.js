// Probe test against a fake JetBrains IDE MCP server that speaks the
// Streamable-HTTP endpoint the plugin now uses: POST /stream with an
// `initialize` request returns a 2xx JSON reply.

import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { findIdePort, probePort } from '../src/mcp/idea.js';

function startFakeIde() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/stream' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let message = {};
        try {
          message = JSON.parse(body);
        } catch {
          // ignore
        }
        if (message.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } },
            }),
          );
          return;
        }
        res.writeHead(202).end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let running;
afterEach(async () => {
  if (running) {
    await new Promise((resolve) => running.close(resolve));
    running = undefined;
  }
});

describe('probePort', () => {
  it('returns true when the IDE MCP server responds', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    await expect(probePort(fake.port)).resolves.toBe(true);
  });

  it('returns false when the IDE HTTP port only redirects /stream', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(301, { Location: '/stream/' }).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    running = server;
    await expect(probePort(server.address().port)).resolves.toBe(false);
  });

  it('returns false when nothing is listening', async () => {
    await expect(probePort(1)).resolves.toBe(false);
  });
});

describe('findIdePort', () => {
  it('finds the port that responds and ignores dead ports', async () => {
    const fake = await startFakeIde();
    running = fake.server;
    await expect(findIdePort([1, fake.port])).resolves.toBe(fake.port);
  });

  it('returns undefined when no port responds', async () => {
    await expect(findIdePort([1, 2])).resolves.toBeUndefined();
  });
});
