// End-to-end probe test against a fake JetBrains IDE MCP server.
//
// The fake reproduces the two behaviors the probe depends on:
//   * GET /sse          -> 200 text/event-stream with an `endpoint` event
//   * POST /message     -> the JSON-RPC reply is pushed back over /sse
//   * tools/call        -> isError:false only when the request's
//                          IJ_MCP_SERVER_PROJECT_PATH matches the open project

import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeOpenProject, probePort } from '../src/idea-mcp.js';

function startFakeIde(openPath) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': heartbeat\n\n');
        res.write('event: endpoint\ndata: /message?sessionId=fake\n\n');
        server.sse = res;
        req.on('close', () => {
          if (server.sse === res) server.sse = undefined;
        });
        return;
      }

      if (url.pathname === '/message') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const message = JSON.parse(body);
          const reply = (payload) => {
            if (server.sse) server.sse.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          if (message.id === 1) {
            reply({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
          } else if (message.id === 2) {
            const open = req.headers.ij_mcp_server_project_path === openPath;
            reply({
              jsonrpc: '2.0',
              id: 2,
              result: open
                ? { content: [{ type: 'text', text: '{"modules":[]}' }], isError: false }
                : { content: [{ type: 'text', text: 'Unable to determine the target project' }], isError: true },
            });
          }
          res.writeHead(202).end();
        });
        return;
      }

      res.writeHead(404).end();
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
  it('returns true when the project is open', async () => {
    const fake = await startFakeIde('/open/project');
    running = fake.server;
    await expect(probePort(fake.port, '/open/project')).resolves.toBe(true);
  });

  it('returns false when the project is not open', async () => {
    const fake = await startFakeIde('/open/project');
    running = fake.server;
    await expect(probePort(fake.port, '/other/project')).resolves.toBe(false);
  });

  it('returns false when nothing is listening', async () => {
    await expect(probePort(1, '/anything')).resolves.toBe(false);
  });
});

describe('probeOpenProject', () => {
  it('finds the port that serves the project and ignores dead ports', async () => {
    const fake = await startFakeIde('/open/project');
    running = fake.server;

    await expect(probeOpenProject('/open/project', [1, fake.port])).resolves.toBe(fake.port);
    await expect(probeOpenProject('/somewhere/else', [1, fake.port])).resolves.toBeUndefined();
  });
});
