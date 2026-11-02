/* 비밀번호 규칙 — supabase/functions/account-admin/core.mjs 의 passwordProblems 와 똑같이 동작해야 합니다.
   (tests/test_admin_policy_parity.mjs 가 둘을 같은 입력으로 비교합니다) 화면은 이 규칙으로 미리 알려 주고, 저장할 때 서버가 같은 규칙으로 다시 검사합니다. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PwPolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SYMBOLS = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', ';', "'", '\\', ':', '"', '|', '<', '>', '?', ',', '.', '/', '`', '~'].join('');
  function chars(s) { return Array.from(s); }
  function byteLength(s) { return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length; }
  // 2026-11-02 사용자 결정: 간단하게 — 8자 이상, 영문·숫자 각 1개 이상(Supabase 'Letters and digits'). 공백·제어 문자와 72바이트 초과도 막음
  function problems(pw, username) {
    if (typeof pw !== 'string' || !pw) return ['비밀번호를 입력하세요'];
    var p = [];
    if (chars(pw).length < 8) p.push('8자 이상');
    if (byteLength(pw) > 72) p.push('72바이트 이하(영문 72자)');
    if (!/[A-Za-z]/.test(pw)) p.push('영문 필요');
    if (!/[0-9]/.test(pw)) p.push('숫자 필요');
    if (/[\s\u0000-\u001f]/.test(pw)) p.push('공백·제어 문자 불가');
    return p;
  }
  // 무작위 비밀번호: 영문 소문자+숫자 8자(헷갈리는 0 o 1 l i 뺌) — 서버 genPassword 와 같은 모양
  var SET = 'abcdefghjkmnpqrstuvwxyz23456789';
  function generate(username, randomBytes) {
    var rb = randomBytes || function (n) { return crypto.getRandomValues(new Uint8Array(n)); };
    function randInt(n) { var limit = 256 - (256 % n); for (;;) { var b = rb(32); for (var i = 0; i < b.length; i++) if (b[i] < limit) return b[i] % n; } }
    for (var tries = 0; tries < 50; tries++) {
      var c = []; while (c.length < 8) c.push(SET[randInt(SET.length)]);
      var pw = c.join('');
      if (/[a-z]/.test(pw) && /[0-9]/.test(pw) && problems(pw, username).length === 0) return pw;
    }
    throw new Error('비밀번호를 만들지 못했습니다');
  }
  return { SYMBOLS: SYMBOLS, problems: problems, generate: generate };
});
