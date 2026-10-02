// 브라우저 시험용 작은 서버: 저장소 파일(정적) + /api(서버 코드, D1 흉내) 를 한 주소에서 제공
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoutes, makeD1, matchRoute } from './_cf_harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const routes = await loadRoutes();
const env = { DB: makeD1(), PBKDF2_ITERATIONS: '1000', SETUP_TOKEN: process.env.SETUP_TOKEN || 'setup-code-for-tests' };
const port = Number(process.argv[2] || 0);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      headers.set('CF-Connecting-IP', '127.0.0.1');
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const m = matchRoute(routes, url.pathname, req.method);
      if (!m) { res.writeHead(404); return res.end('no route'); }
      const out = await m.handler({ request, env, params: m.params });
      const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(out.status, h); return res.end(Buffer.from(await out.arrayBuffer()));
    }
    let p = normalize(join(ROOT, decodeURIComponent(url.pathname))); if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(port, '127.0.0.1', function () { console.log('LISTENING ' + this.address().port); });
