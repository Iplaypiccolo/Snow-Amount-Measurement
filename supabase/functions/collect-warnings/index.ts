// Supabase Edge Function 진입점: 기상특보 받기(collect-warnings)를 Supabase 와 이어 줍니다.
// 서비스 키는 Supabase 가, 기상청 키(KMA_AUTH_KEY)는 함수 비밀값으로 넣어 줍니다. 코드나 저장소에는 키가 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './core.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// 기상청 응답은 EUC-KR 인 때가 많음 → UTF-8 로 읽어 보고 안 되면 EUC-KR
function decode(buf: ArrayBuffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('euc-kr').decode(buf); }
}

const deps = {
  now: () => Date.now(),
  env: (k: string) => Deno.env.get(k) ?? '',
  async fetchText(u: string) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try { const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'snow-support-warnings' } }); return { status: r.status, text: decode(await r.arrayBuffer()) }; }
    catch { return { status: 0, text: '' }; } finally { clearTimeout(timer); }
  },
  auth: { async getUser(jwt: string) { const { data } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null }; } },
  store: {
    async tokenOk(t: string) { const { data } = await admin.rpc('collector_token_ok', { t }); return data === true; },
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,role,disabled').eq('id', id).maybeSingle(); return data; },
    async ingest(p: unknown) { const { data, error } = await admin.rpc('ingest_warnings', { p }); if (error) console.error('ingest_warnings', error.message); return { data, error }; },
    async ingestZones(p: unknown) { const { data, error } = await admin.rpc('ingest_warning_zones', { p }); if (error) console.error('ingest_warning_zones', error.message); return { data, error }; },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('collect-warnings: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
