import { handle } from './core.mjs';

// 별도 점검 함수: 기존 예보 수집 코드/일정/자료를 변경하지 않는다.
const base = Deno.env.get('SUPABASE_URL') ?? '';
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const deps = {
  now: () => Date.now(),
  env: (name: string) => Deno.env.get(name) ?? '',
  async tokenOk(t: string) {
    const r = await fetch(base + '/rest/v1/rpc/collector_token_ok', {
      method: 'POST', headers: { apikey: secret, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ t }), signal: AbortSignal.timeout(10000),
    });
    return r.ok && await r.json() === true;
  },
  async fetchText(url: string) {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('euc-kr').decode(bytes); }
    return { status: r.status, text, bytes: bytes.length };
  },
};
Deno.serve((req: Request) => {
  if (!base || !secret) return new Response('{"ok":false,"error":"server_misconfigured"}', { status: 503 });
  return handle(req, deps);
});
