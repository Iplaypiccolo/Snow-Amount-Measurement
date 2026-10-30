// Supabase Edge Function 진입점: 일 신적설 자동 수집(collect-snow)을 Supabase 와 이어 줍니다.
// 서비스 키는 Supabase 가, 기상청 키(KMA_AUTH_KEY)는 함수 비밀값으로 넣어 줍니다. 코드나 저장소에는 키가 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, CALL_MS } from './core.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const deps = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  env: (k: string) => Deno.env.get(k) ?? '',
  async fetchText(u: string) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), CALL_MS);
    try {
      const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'snow-support-snow' } });
      return { status: r.status, text: new TextDecoder('euc-kr').decode(await r.arrayBuffer()) };   // 기상청 글은 EUC-KR
    } catch { return { status: 0, text: '' }; } finally { clearTimeout(timer); }
  },
  auth: { async getUser(jwt: string) { const { data } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null }; } },
  store: {
    async tokenOk(t: string) { const { data } = await admin.rpc('collector_token_ok', { t }); return data === true; },
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,role,disabled').eq('id', id).maybeSingle(); return data; },
    async plan(p_date: string | null) { const { data, error } = await admin.rpc('snow_plan', p_date ? { p_date } : {}); if (error) console.error('snow_plan', error.message); return { data, error }; },
    async put(p_date: string, p_hour: number, p_vals: Record<string, number>, p_dry: boolean) {
      const { data, error } = await admin.rpc('snow_put', { p_date, p_hour, p_vals, p_dry }); if (error) console.error('snow_put', error.message); return { data, error };
    },
    async finish(p_date: string, p_hours: number, p_written: number, p_note: string) {
      const { error } = await admin.rpc('snow_finish', { p_date, p_hours, p_written, p_note }); if (error) console.error('snow_finish', error.message);
    },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('collect-snow: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
