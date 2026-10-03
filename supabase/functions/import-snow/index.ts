// Supabase Edge Function 진입점: 일 신적설 넣기(import-snow)를 Supabase 와 이어 줍니다.
// 서비스 키는 Supabase 가 함수 환경에 자동으로 넣어 줍니다. 코드나 저장소에는 키가 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './core.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const deps = {
  now: () => new Date(),
  sha256hex: async (t: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))),
  async fetchText(u: string) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    try { const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'snow-support-import' } }); return r.ok ? await r.text() : null; }
    catch { return null; } finally { clearTimeout(timer); }
  },
  auth: { async getUser(jwt: string) { const { data, error } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null, error }; } },
  store: {
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,username,role,disabled,must_change').eq('id', id).maybeSingle(); return data; },
    // 일회용 시작 토큰: 맞는 해시를 "지우면서" 확인 → 동시에 두 번 불러도 한 번만 통과
    async consumeBootstrap(hash: string, now: Date) {
      const { data } = await admin.from('settings').delete().eq('key', 'bootstrap_token').eq('value->>hash', hash).select('value');
      const v = (data && data[0]?.value) as { expires_at?: string } | undefined;
      return !!(v && v.expires_at && Date.parse(v.expires_at) >= now.getTime());
    },
    async importSnow(p: unknown, overwrite: boolean, dry: boolean) { const { data, error } = await admin.rpc('admin_import_snow', { p, overwrite, dry }); return { counts: data as Record<string, number> | null, error }; },
    async rebuildSnapshot() { const { data, error } = await admin.rpc('admin_rebuild_snow_snapshot'); return { result: data, error }; },
    async logUpload(row: Record<string, unknown>) { const { error } = await admin.from('snow_uploads').insert(row); return { error }; },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('import-snow: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
