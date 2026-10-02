// 공통 도우미: 응답 만들기, 쿠키, 같은 사이트에서 온 요청인지 확인
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export const fail = (status, code, message, extra = {}) => json({ ok: false, error: code, message, ...extra }, status);

export function clientIp(request) {
  // Cloudflare 가 붙여 주는 접속자 IP. 브라우저가 보내는 값이 아니라 믿을 수 있습니다.
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// 로그인 같은 "바꾸는 요청"은 같은 사이트에서 보낸 것만 받습니다 (다른 사이트가 몰래 보내는 요청 방지)
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export async function readJson(request, maxBytes = 4096) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function parseCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

export const COOKIE_NAME = '__Host-sid';   // __Host- : HTTPS 전용, 도메인 고정

export function sessionCookie(value, maxAgeSec) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
