// Plain Node server entry point — for Render, Railway, Fly, local dev, or any
// host that runs `npm start`. Exposes the SAME endpoint path as the Vercel
// deployment (/api/relay), so client code needs no changes between platforms.
//
// Listens on process.env.PORT (Render and most hosts inject it) or 3000.
import http from 'node:http';
import { URL as NodeURL } from 'node:url';
import handler from './lib/relay.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
  const path = new NodeURL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  // Serve the relay at /api/relay (and tolerate a trailing slash),
  // same path as the Vercel deployment.
  if (path === '/api/relay' || path === '/api/relay/') {
    const u = new NodeURL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.query = Object.fromEntries(u.searchParams.entries());

    // Minimal Vercel-style helpers the handler expects
    res.status = function status(code) {
      this.statusCode = code;
      return this;
    };
    res.json = function json(obj) {
      this.setHeader('Content-Type', 'application/json');
      return this.send(JSON.stringify(obj));
    };
    res.send = function send(body) {
      const data =
        body == null ? Buffer.alloc(0)
        : Buffer.isBuffer(body) ? body
        : Buffer.from(String(body));
      this.setHeader('Content-Length', String(data.length));
      this.end(req.method === 'HEAD' ? undefined : data);
      return this;
    };

    try {
      await handler(req, res);
      if (!res.headersSent) res.end();
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
    return;
  }

  // Everything else: simple JSON 404
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`relay proxy listening on http://${HOST}:${PORT}/api/relay?url=...`);
});
