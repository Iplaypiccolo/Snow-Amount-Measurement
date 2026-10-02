// Cloudflare 없이 서버 코드를 시험하기 위한 도구:
//  - D1 흉내(node 내장 SQLite) / Pages 라우터 흉내 / 요청 만들기
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- D1 흉내 ---- */
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
}
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'cloudflare/schema.sql'), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}

/* ---- Pages 라우터 흉내: functions/ 폴더의 파일 경로 → 주소 ---- */
function walk(dir, base = '') {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n), rel = base ? `${base}/${n}` : n;
    return statSync(p).isDirectory() ? walk(p, rel) : [{ file: p, rel }];
  });
}
export async function loadRoutes() {
  const routes = [];
  for (const { file, rel } of walk(join(ROOT, 'functions/api'))) {
    if (!rel.endsWith('.js')) continue;
    const parts = rel.replace(/\.js$/, '').split('/');
    const pat = '/api/' + parts.map((s) => (s.startsWith('[') ? ':' + s.slice(1, -1) : s)).join('/');
    routes.push({ pat, segs: pat.split('/'), mod: await import(pathToFileURL(file).href) });
  }
  routes.sort((a, b) => a.pat.split(':').length - b.pat.split(':').length);   // 고정 주소를 먼저
  return routes;
}
export function matchRoute(routes, pathname, method) {
  const segs = pathname.replace(/\/+$/, '').split('/');
  for (const r of routes) {
    if (r.segs.length !== segs.length) continue;
    const params = {}; let ok = true;
    r.segs.forEach((s, i) => { if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(segs[i]); else if (s !== segs[i]) ok = false; });
    if (!ok) continue;
    const h = r.mod['onRequest' + method[0] + method.slice(1).toLowerCase()] || r.mod.onRequest;
    if (h) return { handler: h, params };
  }
  return null;
}

/* ---- 서버 한 대(DB 포함) ---- */
export async function makeServer(envExtra = {}) {
  const routes = await loadRoutes();
  const env = { DB: makeD1(), PBKDF2_ITERATIONS: '1000', ...envExtra };     // 시험은 빠르게 하려고 반복 횟수를 줄임
  const call = async (path, { method = 'GET', body, cookie, ip = '203.0.113.7', origin = 'https://app.test', headers = {} } = {}) => {
    const url = new URL(path, 'https://app.test');
    const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
    if (cookie) h.set('Cookie', cookie);
    if (origin && method !== 'GET') h.set('Origin', origin);
    let b; if (body !== undefined) { b = typeof body === 'string' ? body : JSON.stringify(body); h.set('Content-Type', 'application/json'); }
    const request = new Request(url, { method, headers: h, body: b });
    const m = matchRoute(routes, url.pathname, method);
    if (!m) return { status: 404, json: null, headers: new Headers(), text: 'no route' };
    const res = await m.handler({ request, env, params: m.params });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, headers: res.headers, text };
  };
  return { env, call, routes };
}
export const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];
