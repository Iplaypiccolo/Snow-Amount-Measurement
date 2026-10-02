// Supabase Edge Function 진입점: Supabase(Auth·DB·Storage)를 core.mjs 가 쓰는 모양으로 이어 줍니다.
// 서비스 키(SUPABASE_SERVICE_ROLE_KEY)는 Supabase 가 함수 환경에 자동으로 넣어 줍니다. 코드나 저장소에는 키가 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './core.mjs';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const deps = {
  now: () => new Date(),
  random: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  sha256hex: async (t: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))),
  auth: {
    async getUser(jwt: string) { const { data, error } = await admin.auth.getUser(jwt); return { id: data?.user?.id ?? null, error }; },
    async createUser(p: { email: string; password: string }) {
      const { data, error } = await admin.auth.admin.createUser({ ...p, email_confirm: true, app_metadata: { provisioned_by: 'account-admin' } });
      return { id: data?.user?.id ?? null, error };
    },
    async updatePassword(id: string, password: string) { const { error } = await admin.auth.admin.updateUserById(id, { password }); return { error }; },
    async setBan(id: string, banned: boolean) { const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' }); return { error }; },
    async deleteUser(id: string) { const { error } = await admin.auth.admin.deleteUser(id); return { error }; },
  },
  store: {
    async getProfileById(id: string) { const { data } = await admin.from('profiles').select('id,username,display_name,role,branch_id,disabled,must_change').eq('id', id).maybeSingle(); return data; },
    async getProfileByUsername(u: string) { const { data } = await admin.from('profiles').select('id,username,display_name,role,branch_id,disabled,must_change').eq('username', u).maybeSingle(); return data; },
    async existingUsernames(list: string[]) { const { data } = await admin.from('profiles').select('username').in('username', list); return (data ?? []).map((r: { username: string }) => r.username); },
    async branchIds(ids: string[]) { if (!ids.length) return []; const { data } = await admin.from('branches').select('id').in('id', ids); return (data ?? []).map((r: { id: string }) => r.id); },
    async insertProfile(p: Record<string, unknown>) { const { error } = await admin.from('profiles').insert(p); return { error }; },
    async updateProfile(id: string, patch: Record<string, unknown>) { const { error } = await admin.from('profiles').update(patch).eq('id', id); return { error }; },
    async countActiveAdmins() { const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('disabled', false); return count ?? 0; },
    async insertAudit(rows: Record<string, unknown>[]) { const { error } = await admin.from('audit_log').insert(rows); return { error }; },
    async revokeSessions(uid: string) { const { error } = await admin.rpc('admin_revoke_sessions', { uid }); return { error }; },
    async uploadCsv(path: string, text: string) {
      const { error } = await admin.storage.from('credentials').upload(path, new Blob([text], { type: 'text/csv' }), { contentType: 'text/csv; charset=utf-8', upsert: false });
      return { error };
    },
    // 일회용 시작 토큰: settings 의 'bootstrap_token' 값(해시, 만료시각)과 맞으면 한 번만 통과하고 바로 지운다
    async consumeBootstrap(hash: string, now: Date) {
      const { data } = await admin.from('settings').select('value').eq('key', 'bootstrap_token').maybeSingle();
      const v = data?.value as { hash?: string; expires_at?: string } | undefined;
      if (!v || v.hash !== hash || !v.expires_at || Date.parse(v.expires_at) < now.getTime()) return false;
      await admin.from('settings').delete().eq('key', 'bootstrap_token');
      return true;
    },
  },
};

Deno.serve((req: Request) => {
  if (!url || !key) { console.error('account-admin: SUPABASE_URL 또는 서비스 키 환경변수가 없습니다'); return new Response(JSON.stringify({ ok: false, error: 'server_misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return handle(req, deps);
});
