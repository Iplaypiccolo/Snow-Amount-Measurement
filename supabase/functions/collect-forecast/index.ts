// Supabase Edge Function 진입점: 예상 적설 받기(collect-forecast)를 Supabase 와 이어 줍니다.
// 서비스 키는 Supabase 가, 기상청 키(KMA_AUTH_KEY)는 함수 비밀값으로 넣어 줍니다. 코드나 저장소에는 키가 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './core.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const deps = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  env: (k: string) => Deno.env.get(k) ?? '',
  async fetchText(u: string) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try { const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'snow-support-forecast' } }); return { status: r.status, text: await r.text() }; }
    catch { return { status: 0, text: '' }; } finally { clearTimeout(timer); }
  },
  auth: { async getUser(jwt: string) { const { data } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null }; } },
  store: {
    async tokenOk(t: string) { const { data } = await admin.rpc('collector_token_ok', { t }); return data === true; },
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,role,disabled').eq('id', id).maybeSingle(); return data; },
    async plan() { const { data, error } = await admin.rpc('forecast_plan'); if (error) console.error('forecast_plan', error.message); return { data, error }; },
    async put(p_tmfc: string, p_var: string, p_tmef: string, p_vals: number[]) { const { data, error } = await admin.rpc('forecast_put', { p_tmfc, p_var, p_tmef, p_vals }); if (error) console.error('forecast_put', error.message); return { data, error }; },
    async fail(p_note: string) { const { error } = await admin.rpc('forecast_fail', { p_note }); if (error) console.error('forecast_fail', error.message); },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('collect-forecast: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
