// Supabase Edge Function 진입점: GitHub 공개 자료를 읽어 DB 에 넣는 import-reference 를 Supabase 와 이어 줍니다.
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
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try { const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'snow-support-import' } }); return r.ok ? await r.text() : null; }
    catch { return null; } finally { clearTimeout(timer); }
  },
  auth: { async getUser(jwt: string) { const { data, error } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null, error }; } },
  store: {
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,username,role,disabled,must_change').eq('id', id).maybeSingle(); return data; },
    async consumeBootstrap(hash: string, now: Date) {
      const { data } = await admin.from('settings').select('value').eq('key', 'bootstrap_token').maybeSingle();
      const v = data?.value as { hash?: string; expires_at?: string } | undefined;
      if (!v || v.hash !== hash || !v.expires_at || Date.parse(v.expires_at) < now.getTime()) return false;
      await admin.from('settings').delete().eq('key', 'bootstrap_token');
      return true;
    },
    async importReference(payload: unknown) { const { data, error } = await admin.rpc('admin_import_reference', { payload }); return { counts: data as Record<string, number> | null, error }; },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('import-reference: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
