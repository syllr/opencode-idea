// Fake JetBrains IDE MCP server for tests: the Streamable-HTTP endpoint the
// plugin uses (`/stream`). Answers `initialize` with a 2xx JSON reply, which is
// all the availability probe needs, and answers `tools/call` like the real IDE:
// it binds follow-up requests to the `Mcp-Session-Id` returned by `initialize`,
// and resolves the target project from `IJ_MCP_SERVER_PROJECT_PATH` — a path the
// server does not consider open fails with the real "Unable to determine the
// target project" message.

import { createServer } from 'node:http';

/**
 * Start a fake IDE MCP server. Resolves `{ server, port, streamRequests,
 * setProjectOpen }`. Pass `port` to bind a specific port (0 = random).
 *
 * 每个实例有**自己**的一份"已打开项目"集合：IDEA 与 PyCharm 是两个进程，一个认得
 * 一个项目，不该让另一个也跟着认得（多项目场景全靠这一点区分端口归属）。
 *
 * `setProjectOpen(path, open)`: live switch for whether a project path counts as
 * open. `setProjectOpen(false)` is shorthand for clearing this instance's set.
 *
 * @param {number} [port]
 */
export function startFakeIde(port = 0) {
  return new Promise((resolve) => {
    let streamRequests = 0;
    const openProjects = new Set();
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/stream' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      streamRequests += 1;
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
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fake-session' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } },
            }),
          );
          return;
        }
        if (message.method === 'tools/call') {
          const project = req.headers['ij_mcp_server_project_path'];
          if (!project || !openProjects.has(project)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: 'Unable to determine the target project for the current MCP tool call.',
                    },
                  ],
                  isError: true,
                },
              }),
            );
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: '{"modules":[]}' }], isError: false },
            }),
          );
          return;
        }
        res.writeHead(202).end();
      });
    });
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        streamRequests: () => streamRequests,
        /** Mark a project path as open in this fake IDE (a string path, or `false`). */
        setProjectOpen: (path, open = true) => {
          if (typeof path === 'string' && open) openProjects.add(path);
          else if (typeof path === 'string') openProjects.delete(path);
          else openProjects.clear();
        },
      }),
    );
  });
}
