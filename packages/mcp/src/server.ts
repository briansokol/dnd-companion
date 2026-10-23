import { createServer as createHttpServer, type Server } from 'node:http';

/** The internal HTTP API. For now it only answers the compose healthcheck. */
export function createServer(): Server {
  return createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });
}
