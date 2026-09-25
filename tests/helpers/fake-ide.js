// Fake JetBrains IDE MCP server for tests: the Streamable-HTTP endpoint the
// plugin uses (`/stream`). Answers `initialize` with a 2xx JSON reply, which is
// all the availability probe needs.

import { createServer } from 'node:http';

/**
 * Start a fake IDE MCP server. Resolves `{ server, port }`. Pass `port` to bind
 * a specific port (0 = random).
 *
 * @param {number} [port]
 */
export function startFakeIde(port = 0) {
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
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
