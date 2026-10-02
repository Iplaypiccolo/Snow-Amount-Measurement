import { json } from '../_lib/http.js';
import { requireUser } from '../_lib/auth.js';

export async function onRequestGet(context) {
  const { user, response } = await requireUser(context, { allowMustChange: true });
  if (response) return response;
  const { tokenHash, id, ...pub } = user;
  return json({ ok: true, user: pub });
}
