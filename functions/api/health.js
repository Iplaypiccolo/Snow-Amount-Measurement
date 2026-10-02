// 서버와 DB가 살아 있는지만 알려 줍니다 (아무 정보도 노출하지 않음)
import { json } from '../_lib/http.js';
export async function onRequestGet({ env }) {
  try { await env.DB.prepare('SELECT 1').first(); return json({ ok: true }); }
  catch { return json({ ok: false }, 503); }
}
