// 관리자 전용: 접속·수정 기록 (최신순). 보기만 가능하고 고치거나 지우는 기능은 없습니다.
import { json } from '../../_lib/http.js';
import { requireUser } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { user, response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const url = new URL(context.request.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
  const kind = (url.searchParams.get('kind') || '').slice(0, 20);
  const who = (url.searchParams.get('username') || '').slice(0, 64);
  const where = [], args = [];
  if (before) { where.push('id < ?'); args.push(before); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (who) { where.push('username = ?'); args.push(who); }
  const { results } = await context.env.DB.prepare(
    `SELECT id, at, username, kind, tab, target, from_val, to_val, ip FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .bind(...args, limit).all();
  return json({ ok: true, rows: results, next: results.length === limit ? results[results.length - 1].id : null });
}
