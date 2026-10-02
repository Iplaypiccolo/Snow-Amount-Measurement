/* 화면의 비밀번호 규칙(admin/policy.js)이 서버 함수의 규칙(core.mjs)과 똑같이 동작하는지 같은 입력으로 비교
   실행: node tests/test_admin_policy_parity.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { passwordProblems, PW_SYMBOLS } from '../supabase/functions/account-admin/core.mjs';
const require = createRequire(import.meta.url);
const P = require('../admin/policy.js');
const results = [];
const test = (n, f) => { try { f(); results.push([n, true]); } catch (e) { results.push([n, false, e.message.split('\n')[0]]); } };

test('허용 기호 목록이 서버와 같다', () => { assert.equal(P.SYMBOLS, PW_SYMBOLS); assert.equal(P.SYMBOLS.length, 32); });

test('손으로 고른 입력 60개에서 결과가 완전히 같다', () => {
  const pws = ['Snow#Ride-2026k', 'Abcdefghij1!', 'short', '', 'SNOW#RIDE-2026K', 'snow#ride-2026k', 'SnowRide2026kk', 'Snow Ride#2026k', 'Snow#Rideeee-26k', 'Snow#Ride-1234k', 'Snow#Ride-dcba7',
    'Snow#exchungju9Z', 'Snow#Chungju-99Z', 'A'.repeat(40) + 'a1!' + 'B'.repeat(40), '한글비밀번호열두글자이상!Aa1', 'Pässwörd#2026-Zx', 'Tab\tBad#Pass-2026', 'Ok#Pass-w0rd-xyz9', 'Zq7!Zq7!Zq7!Zq7!', '😀Snow#Ride-2026k', 'Snow#Ride-2026k\n'];
  const users = ['exchungju', 'exdongseoul', 'admin-01', 'equip-01', 'exgyeonggigwangju', ''];
  let n = 0; for (const pw of pws) for (const u of users) { assert.deepEqual(P.problems(pw, u), passwordProblems(pw, u), JSON.stringify([pw, u])); n++; }
  assert.ok(n >= 120);
});

test('무작위 입력 5,000개에서 결과가 완전히 같다', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{};\':"|<>?,./`~\\ \t가나다😀exchungju';
  const users = ['exchungju', 'exincheon', 'admin-01', 'equip-01', 'exdaegwallyeong', 'exgyeonggigwangju'];
  for (let i = 0; i < 5000; i++) {
    const len = Math.floor(rnd() * 30); let pw = ''; for (let k = 0; k < len; k++) pw += Array.from(pool)[Math.floor(rnd() * Array.from(pool).length)];
    const u = users[i % users.length]; assert.deepEqual(P.problems(pw, u), passwordProblems(pw, u), JSON.stringify([pw, u]));
  }
});

test('무작위 생성기: 규칙을 항상 만족하고, 서로 다르고, 4종류 글자가 모두 들어 있다', () => {
  const rb = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); return a; }, seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const u = ['exchungju', 'exgurye', 'equip-01'][i % 3], pw = P.generate(u, rb);
    assert.equal(pw.length, 16); assert.deepEqual(P.problems(pw, u), []); assert.deepEqual(passwordProblems(pw, u), []);
    assert.ok(!/^[!#$%&*+\-=?@]/.test(pw), '첫 글자가 기호'); assert.ok(!/[0OIl1]/.test(pw)); seen.add(pw);
  }
  assert.equal(seen.size, 1000);
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
