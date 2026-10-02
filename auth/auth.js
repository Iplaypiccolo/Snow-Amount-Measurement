/* ============================================================
   auth/auth.js — 로그인 공통 부품 (첫 화면·관리 콘솔·장비 지원 화면이 함께 씁니다)
   - Supabase(서울)에 아이디·비밀번호로 로그인하고, 로그인 상태를 "이 브라우저의 저장소"에 보관합니다.
   - 쿠키나 캐시가 아니라 브라우저 저장소(localStorage/sessionStorage)를 쓰는 이유는 docs/login-gate.md 에 설명했습니다.
   - 비밀번호는 어디에도 저장하지 않습니다. 저장하는 것은 ① 로그인 토큰(열쇠) ② (선택) 아이디 뿐입니다.
   - 이 파일에는 비밀 키가 없습니다. 공개 키(publishable)만 쓰고, 무엇을 할 수 있는지는 서버(DB 권한)가 매번 검사합니다.
   ============================================================ */
(function (root) {
  'use strict';
  var CFG = root.SS_CFG || root.ADMIN_CFG || {
    url: 'https://yzwbnohzhnctdvufntig.supabase.co',
    key: 'sb_publishable_PQNwbLdG3wNUqA8u50G6Sw_qks53KcQ',       // 공개 키(브라우저에 넣도록 만든 키)
    emailDomain: 'snow-support.invalid'                         // 아이디를 이메일 모양으로 바꾸는 가짜 도메인(메일은 보내지 않음)
  };
  var K = { session: 'ss_session', user: 'ss_saved_user' };
  var DAY = 86400000;
  var AUTO_DAYS = { admin: 7, other: 30 };                      // 자동 로그인 유지 기간: 관리자는 짧게
  var NET_MSG = '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요. (회사 네트워크에서 supabase.co 접속이 막혀 있을 수도 있습니다)';

  function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  // 브라우저 저장소를 못 쓰는 환경(일부 보안 설정·미리보기 창)에서는 이 페이지가 열려 있는 동안만 기억합니다(기능은 그대로 동작)
  var MEM = { localStorage: {}, sessionStorage: {} };
  function stor(name) {
    try { var s = root[name]; s.getItem('__ss_probe'); return s; } catch (e) {}
    return { getItem: function (k) { return MEM[name][k] == null ? null : MEM[name][k]; }, setItem: function (k, v) { MEM[name][k] = String(v); }, removeItem: function (k) { delete MEM[name][k]; } };
  }
  function get(st, k) { try { return st.getItem(k); } catch (e) { return null; } }
  function set(st, k, v) { try { st.setItem(k, v); return true; } catch (e) { return false; } }
  function del(st, k) { try { st.removeItem(k); } catch (e) {} }

  /* ---------- 저장 위치: 자동 로그인 = localStorage(탭을 닫아도 유지), 아니면 sessionStorage(탭을 닫으면 사라짐) ---------- */
  function readSession() {
    var s = parse(get(stor('sessionStorage'), K.session));
    if (s && s.access_token) return s;
    s = parse(get(stor('localStorage'), K.session));
    if (s && s.access_token) {
      if (!s.auto_until || s.auto_until < Date.now()) { del(stor('localStorage'), K.session); return null; }   // 자동 로그인 기간이 지남
      return s;
    }
    return null;
  }
  function writeSession(s) {
    del(stor('sessionStorage'), K.session); del(stor('localStorage'), K.session);
    if (s) set(s.persist ? stor('localStorage') : stor('sessionStorage'), K.session, JSON.stringify(s));
  }
  function savedUser() { return get(stor('localStorage'), K.user) || ''; }
  function rememberUser(u) { if (u) set(stor('localStorage'), K.user, u); else del(stor('localStorage'), K.user); }

  /* ---------- 서버와 통신 ---------- */
  function raw(path, opt) {
    opt = opt || {};
    var h = { apikey: CFG.key }; if (opt.body !== undefined) h['Content-Type'] = 'application/json';
    if (opt.token) h.Authorization = 'Bearer ' + opt.token;
    return fetch(CFG.url + path, { method: opt.method || 'GET', headers: h, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined, cache: 'no-store' })
      .then(function (r) { return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {} return { status: r.status, ok: r.ok, json: j }; }); });
  }
  function toSession(j, prev) {
    prev = prev || {};
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      user_id: (j.user && j.user.id) || prev.user_id, persist: !!prev.persist, auto_until: prev.auto_until || 0, username: prev.username || '' };
  }
  function withLock(fn) {          // 탭이 여러 개일 때 토큰을 동시에 새로 받다가 꼬이지 않게 한 번에 하나씩
    if (root.navigator && root.navigator.locks && root.navigator.locks.request) return root.navigator.locks.request('ss_refresh', function () { return Promise.resolve().then(fn); });
    return Promise.resolve().then(fn);
  }
  // 로그인 토큰(열쇠)은 1시간쯤 쓰면 만료되므로, 곧 만료되면 자동으로 새로 받습니다
  function fresh() {
    var s = readSession(); if (!s) return Promise.reject(new Error('no_session'));
    if (s.expires_at - Date.now() > 60000) return Promise.resolve(s.access_token);
    return withLock(function () {
      var s2 = readSession(); if (!s2) throw new Error('no_session');
      if (s2.expires_at - Date.now() > 60000) return s2.access_token;                   // 다른 탭이 이미 새로 받음
      return raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s2.refresh_token } }).then(function (r) {
        if (r.status >= 500 || r.status === 0) throw new Error('network');
        if (!r.ok || !r.json || !r.json.access_token) { writeSession(null); throw new Error('no_session'); }   // 서버가 로그인을 끊었거나(비밀번호 변경·비활성화 등) 만료
        var n = toSession(r.json, s2); writeSession(n); return n.access_token;
      });
    });
  }
  function authed(path, opt) { return fresh().then(function (t) { opt = opt || {}; opt.token = t; return raw(path, opt); }); }
  function rest(path) { return authed('/rest/v1/' + path); }
  function fn(body) { return authed('/functions/v1/account-admin', { method: 'POST', body: body }); }

  /* ---------- 내 정보(역할) 확인 ---------- */
  function loadMe() {
    var s = readSession(); if (!s) return Promise.resolve({ ok: false, reason: 'none' });
    return rest('profiles?select=id,username,display_name,role,branch_id,must_change,disabled&id=eq.' + encodeURIComponent(s.user_id)).then(function (r) {
      var p = r.ok && Array.isArray(r.json) && r.json[0];
      if (!p) { if (r.status === 401) { writeSession(null); return { ok: false, reason: 'expired', message: '로그인이 만료되었습니다. 다시 로그인하세요.' }; } writeSession(null); return { ok: false, reason: 'unregistered', message: r.ok ? '이 계정은 아직 등록되어 있지 않습니다. 관리자에게 문의하세요.' : '로그인이 만료되었습니다. 다시 로그인하세요.' }; }
      if (p.disabled) { writeSession(null); return { ok: false, reason: 'disabled', message: '비활성화된 계정입니다. 관리자에게 문의하세요.' }; }
      return { ok: true, me: p };
    }).catch(function (e) {
      if (e && e.message === 'no_session') return { ok: false, reason: 'expired', message: '로그인이 만료되었습니다. 다시 로그인하세요.' };
      return { ok: false, reason: 'network', message: NET_MSG };            // 연결 문제는 로그인 정보를 지우지 않고 다시 시도할 수 있게 둠
    });
  }

  /* ---------- 로그인 / 로그아웃 ---------- */
  // opt.auto: 자동 로그인(이 컴퓨터에서 다음에도 비밀번호를 묻지 않음), opt.remember: 아이디 저장
  function login(username, password, opt) {
    opt = opt || {}; var u = String(username || '').trim().toLowerCase();
    return raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: u + '@' + CFG.emailDomain, password: password } }).then(function (r) {
      if (!r.ok || !r.json || !r.json.access_token) return { ok: false, reason: 'bad', message: r.status === 429 ? '시도가 너무 많습니다. 잠시 뒤에 다시 하세요.' : '아이디 또는 비밀번호가 올바르지 않습니다.' };
      var s = toSession(r.json, { persist: !!opt.auto, username: u, auto_until: opt.auto ? Date.now() + AUTO_DAYS.other * DAY : 0 });
      writeSession(s);
      return loadMe().then(function (res) {
        if (!res.ok) return res;
        if (opt.auto && res.me.role === 'admin') { var c = readSession(); if (c) { c.auto_until = Date.now() + AUTO_DAYS.admin * DAY; writeSession(c); } }
        rememberUser(opt.remember ? u : '');
        return res;
      });
    }).catch(function () { return { ok: false, reason: 'network', message: NET_MSG }; });
  }
  function logout() {
    var s = readSession(); writeSession(null);       // 아이디 저장은 그대로 둠
    return s ? raw('/auth/v1/logout', { method: 'POST', token: s.access_token }).catch(function () {}) : Promise.resolve();
  }
  function hasSession() { return !!readSession(); }

  root.SSAuth = { CFG: CFG, AUTO_DAYS: AUTO_DAYS, NET_MSG: NET_MSG, login: login, logout: logout, restore: loadMe, hasSession: hasSession,
    savedUser: savedUser, rememberUser: rememberUser, raw: raw, authed: authed, rest: rest, fn: fn, session: readSession };
})(typeof window !== 'undefined' ? window : this);
