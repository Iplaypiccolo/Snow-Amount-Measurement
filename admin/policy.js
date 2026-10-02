/* 비밀번호 규칙 — supabase/functions/account-admin/core.mjs 의 passwordProblems 와 똑같이 동작해야 합니다.
   (tests/test_admin_policy_parity.mjs 가 둘을 같은 입력으로 비교합니다) 화면은 이 규칙으로 미리 알려 주고, 저장할 때 서버가 같은 규칙으로 다시 검사합니다. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PwPolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SYMBOLS = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', ';', "'", '\\', ':', '"', '|', '<', '>', '?', ',', '.', '/', '`', '~'].join('');
  function chars(s) { return Array.from(s); }
  function hasRun(pw) {
    var c = chars(pw.toLowerCase()).map(function (x) { return x.codePointAt(0); });
    for (var i = 0; i + 3 < c.length; i++) {
      var d = c[i + 1] - c[i];
      if ((d === 1 || d === -1) && c[i + 2] - c[i + 1] === d && c[i + 3] - c[i + 2] === d) return true;
    }
    return false;
  }
  function byteLength(s) { return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length; }
  function problems(pw, username) {
    if (typeof pw !== 'string' || !pw) return ['비밀번호를 입력하세요'];
    var p = [], low = pw.toLowerCase(), u = String(username || '').toLowerCase(), core = u.replace(/^ex/, '');
    if (chars(pw).length < 12) p.push('12자 이상');
    if (byteLength(pw) > 72) p.push('72바이트 이하(영문 72자)');
    if (!/[a-z]/.test(pw)) p.push('소문자 필요');
    if (!/[A-Z]/.test(pw)) p.push('대문자 필요');
    if (!/[0-9]/.test(pw)) p.push('숫자 필요');
    if (!chars(pw).some(function (c) { return SYMBOLS.indexOf(c) >= 0; })) p.push('기호 필요');
    if (/[\s\u0000-\u001f]/.test(pw)) p.push('공백·제어 문자 불가');
    if (u && low.indexOf(u) >= 0) p.push('아이디 포함 불가');
    else if (core.length >= 4 && low.indexOf(core) >= 0) p.push('지사 이름 포함 불가');
    if (/(.)\1{3,}/.test(pw)) p.push('같은 글자 4번 이상 반복 불가');
    if (hasRun(pw)) p.push('이어지는 글자(abcd·1234) 4개 이상 불가');
    return p;
  }
  // 규칙을 만족하는 16자 무작위 비밀번호 (헷갈리는 글자 0 O 1 l I 와 엑셀·CSV 에서 문제되는 기호는 제외)
  var LOWER = 'abcdefghijkmnpqrstuvwxyz', UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIGIT = '23456789', SYM = '!#$%&*+-=?@', ALL = LOWER + UPPER + DIGIT + SYM;
  function generate(username, randomBytes) {
    var rb = randomBytes || function (n) { return crypto.getRandomValues(new Uint8Array(n)); };
    function randInt(n) { var limit = 256 - (256 % n); for (;;) { var b = rb(32); for (var i = 0; i < b.length; i++) if (b[i] < limit) return b[i] % n; } }
    function pick(set) { return set[randInt(set.length)]; }
    for (var tries = 0; tries < 50; tries++) {
      var c = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYM)];
      while (c.length < 16) c.push(pick(ALL));
      for (var i = c.length - 1; i > 0; i--) { var j = randInt(i + 1), t = c[i]; c[i] = c[j]; c[j] = t; }
      if (SYM.indexOf(c[0]) >= 0) { var k = c.findIndex(function (x) { return SYM.indexOf(x) < 0; }); var t2 = c[0]; c[0] = c[k]; c[k] = t2; }
      var pw = c.join('');
      if (problems(pw, username).length === 0) return pw;
    }
    throw new Error('비밀번호를 만들지 못했습니다');
  }
  return { SYMBOLS: SYMBOLS, problems: problems, generate: generate };
});
