// Local dev server: static files + /api/generate (mirrors Vercel layout)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.md':'text/plain' };

const { default: generate } = await import('./api/generate.js');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      req.body = body;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.writeHead(res.statusCode || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      await generate(req, res);
    });
    return;
  }
  let p = normalize(decodeURIComponent(u.pathname));
  if (p === '/' || p === '\\') p = '/index.html';
  try {
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
const port = process.env.PORT || 3457;
server.listen(port, () => console.log('dev server http://localhost:' + port));
