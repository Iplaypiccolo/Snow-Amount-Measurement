import { runProbe } from './probe.js';

export default {
  // 정해진 시각마다 Cloudflare 가 자동으로 부릅니다 (wrangler.jsonc 의 triggers.crons)
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runProbe(env, 'cron'));
  },

  // 손으로 한 번 실행해 보기: POST /run + 헤더 Authorization: Bearer <TRIGGER_TOKEN>
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/run' && env.TRIGGER_TOKEN
        && request.headers.get('Authorization') === `Bearer ${env.TRIGGER_TOKEN}`) {
      const r = await runProbe(env, 'manual');
      return Response.json({ ok: !!r.ok, http_status: r.http_status, ms: r.ms, error: r.error });
    }
    return new Response('Not found', { status: 404 });
  },
};
