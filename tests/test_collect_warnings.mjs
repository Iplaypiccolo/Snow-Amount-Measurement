/* 특보 받기 함수(supabase/functions/collect-warnings/core.mjs) 자동 테스트 — 특보현황·특보구역 글 읽기, 가짜 DB 로 권한·실패 처리 확인
   실행: node tests/test_collect_warnings.mjs   (저장소 맨 위 폴더에서) */
import assert from 'node:assert/strict';
import { parseNow, parseReg, kst, kstNow, handle, NOW_URL, OLD_URL, REG_URL } from '../supabase/functions/collect-warnings/core.mjs';

const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }

// 기상청 wrn_now_data_new 모양(머리 설명 줄 + 쉼표 줄, 끝은 ",=")
const NOW = [
  '#기준시각:202612150940 ',
  '#START7777',
  '# REG_UP  REG_UP_KO----  REG_ID    REG_KO----  TM_FC         TM_EF         WRN     LVL       CMD   ED_TM',
  'S1250000, 서해중부전해상        , S1252010, 서해중부안쪽먼바다      , 202612150400, 202612150600, 풍랑  , 주의    , 발표, 06일 새벽(03시~06시),=',
  'L1022500, 강릉시                , L1022520, 강릉산지                , 202612150400, 202612150600, 대설  , 경보    , 발표,  ,=',
  'L1022500, 강릉시                , L1022510, 강릉평지                , 202612150400, 202612150600, 대설  , 주의    , 변경,  ,=',
  'L1022500, 강릉시                , L1022510, 강릉평지                , 202612150400, 202612152059, 대설  , 예비    , 발표,  ,=',
  'L1020000, 강원도                , L1022700, 홍천                    , 202612150400, 202612150600, 강풍  , 주의    , 발표,  ,=',
  'L1020000, 강원도                , L1022800, 양구                    , 202612150400, 202612150600, 대설  , 주의    , 해제,  ,=',
  '          ,                     , L1031920, 보령도서                , 202612150400, 202612150558, 강풍  , 예비    , 발표,  ,=',
  '깨진 줄, 1, 2',
].join('\r\n');

const REG = [
  '#START7777',
  '# REG_ID TM_ST        TM_ED        REG_SP   REG_UP   REG_KO---------------------------------- REG_NAME',
  'L1000000 200507010000 210012310000 00000001 00000000 전국                                     전국 ',
  'L1022500 202605311330 210012310000 00000103 L1020000 강릉                                     강릉시 ',
  'L1022520 202605311330 210012310000 00010014 L1022500 강릉산지                                 강릉시산지 ',
  'L1052710 202605311330 210012310000 00000114 L1052700 영광(낙월면 제외)',
  'S1252010 200507010000 210012310000 00000004 S1250000 서해중부안쪽먼바다                       서해중부안쪽먼바다',
].join('\n');

await test('시각: YYYYMMDDHHMM(한국) → ISO, 이상하면 null', () => {
  assert.equal(kst('202612150940'), '2026-12-15T09:40:00+09:00'); assert.equal(kst(''), null); assert.equal(kst('2026'), null);
});
await test('특보현황 읽기: 기준시각, 육상만, 주의→주의, 해제 줄 제외, 같은 구역의 주의+예비 둘 다', () => {
  const r = parseNow(NOW);
  assert.equal(r.base, '202612150940');
  assert.deepEqual(r.rows.map((x) => [x.zone, x.kind, x.level]), [
    ['L1022520', '대설', '경보'], ['L1022510', '대설', '주의'], ['L1022510', '대설', '예비'], ['L1022700', '강풍', '주의'], ['L1031920', '강풍', '예비']]);
  assert.equal(r.rows[0].tm_fc, '2026-12-15T04:00:00+09:00'); assert.equal(r.rows[1].cmd, '변경'); assert.equal(r.rows[0].ed_tm, null);
});
await test('특보현황 읽기: 키 오류 안내문 등 형식이 다르면 기준시각 없음', () => {
  assert.equal(parseNow('{"result":{"status":403,"message":"인증키 오류"}}').base, null); assert.equal(parseNow(null).base, null);
});
await test('특보구역 읽기: 이름 안의 빈칸·REG_NAME 없음·상위 없음', () => {
  const z = parseReg(REG);
  assert.deepEqual(z.map((x) => [x.code, x.up, x.ko, x.name, x.sp]), [
    ['L1000000', null, '전국', '전국', '00000001'], ['L1022500', 'L1020000', '강릉', '강릉시', '00000103'],
    ['L1022520', 'L1022500', '강릉산지', '강릉시산지', '00010014'], ['L1052710', 'L1052700', '영광(낙월면 제외)', null, '00000114'],
    ['S1252010', 'S1250000', '서해중부안쪽먼바다', '서해중부안쪽먼바다', '00000004']]);
});

// 가짜 세상
function world(o = {}) {
  const w = { key: 'K'.repeat(32), fetched: [], ingested: [], zones: [], token: 'tok', users: { 'jwt-a': 'u-a', 'jwt-b': 'u-b' },
    profiles: { 'u-a': { id: 'u-a', role: 'admin', disabled: false }, 'u-b': { id: 'u-b', role: 'branch', disabled: false } },
    resp: { status: 200, text: NOW }, reg: { status: 200, text: REG + '\n' + Array.from({ length: 60 }, (_, i) => `L19${String(i).padStart(5, '0')} 202605311330 210012310000 00000013 L1020000 구역${i}`).join('\n') }, ...o };
  w.deps = {
    now: () => Date.UTC(2026, 11, 15, 0, 41), env: (k) => (k === 'KMA_AUTH_KEY' ? w.key : ''),
    async fetchText(u) { w.fetched.push(u); return u.startsWith(REG_URL) ? w.reg : u.startsWith(OLD_URL) && w.old ? w.old : w.resp; },
    auth: { async getUser(j) { return { id: w.users[j] || null }; } },
    store: {
      async tokenOk(t) { return t === w.token; },
      async getProfileById(id) { return w.profiles[id] || null; },
      async ingest(p) { w.ingested.push(p); return { data: { ok: p.ok, added: p.rows ? p.rows.length : 0 }, error: null }; },
      async ingestZones(p) { w.zones.push(p); return { data: { ok: true, changed: p.length }, error: null }; },
    },
  };
  return w;
}
async function call(w, body, h = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (h.token) headers['x-collector-token'] = h.token; if (h.jwt) headers.authorization = 'Bearer ' + h.jwt;
  const r = await handle(new Request('https://x/collect-warnings', { method: h.method || 'POST', headers, body: h.method === 'GET' ? undefined : JSON.stringify(body || {}) }), w.deps);
  return { status: r.status, j: r.status === 200 && h.method !== 'OPTIONS' ? await r.json() : null };
}

await test('권한: 서버 토큰 또는 관리자만, 지사·토큰 틀림·없음은 401(기상청에 묻지도 않음)', async () => {
  const w = world();
  assert.equal((await call(w, {}, { token: 'nope' })).status, 401); assert.equal((await call(w, {}, { jwt: 'jwt-b' })).status, 401); assert.equal((await call(w, {})).status, 401);
  assert.equal(w.fetched.length, 0);
  assert.equal((await call(w, {}, { token: 'tok' })).status, 200); assert.equal((await call(w, {}, { jwt: 'jwt-a' })).status, 200);
  w.profiles['u-a'].disabled = true; assert.equal((await call(w, {}, { jwt: 'jwt-a' })).status, 401);
  assert.equal((await call(w, {}, { method: 'GET' })).status, 405);
});
await test('정상: 특보현황 한 번 받아 넣고, 대설 줄 수를 알려 줌. 키는 주소에만', async () => {
  const w = world(); const r = await call(w, {}, { token: 'tok' });
  assert.equal(w.fetched.length, 1); assert.equal(w.fetched[0], NOW_URL + w.key);
  assert.equal(w.ingested[0].ok, true); assert.equal(w.ingested[0].base, '202612150940'); assert.equal(w.ingested[0].rows.length, 5);
  assert.equal(r.j.snow, 3); assert.ok(!JSON.stringify(r.j).includes(w.key));
});
await test('실패: 기상청 오류·형식 다름·연결 실패·키 없음은 실패로 기록(키는 기록에 안 남음)', async () => {
  for (const [resp, want] of [[{ status: 500, text: '' }, '응답 500'], [{ status: 200, text: `인증 실패 authKey=${'K'.repeat(32)}` }, '형식이 다름'], [{ status: 0, text: '' }, '연결 실패']]) {
    const w = world({ resp }); const r = await call(w, {}, { token: 'tok' });
    assert.equal(w.ingested[0].ok, false); assert.ok(w.ingested[0].error.includes(want), w.ingested[0].error);
    assert.ok(!w.ingested[0].error.includes(w.key) && !JSON.stringify(r.j).includes(w.key));
  }
  const w = world({ key: '' }); await call(w, {}, { token: 'tok' }); assert.equal(w.fetched.length, 0); assert.ok(w.ingested[0].error.includes('KMA_AUTH_KEY'));
});
await test('새 주소 권한이 없으면(401) 예전 주소로, 기준시각은 받은 시각', async () => {
  assert.equal(kstNow(Date.UTC(2026, 11, 15, 0, 41)), '202612150941');
  const w = world({ resp: { status: 401, text: '' }, old: { status: 200, text: NOW.split(/\r?\n/).slice(1).join('\n') } }); const r = await call(w, {}, { token: 'tok' });
  assert.deepEqual(w.fetched, [NOW_URL + w.key, OLD_URL + w.key]); assert.equal(w.ingested[0].ok, true); assert.equal(w.ingested[0].base, '202612150941'); assert.equal(r.j.src, 'old'); assert.equal(r.j.snow, 3);
  const w2 = world({ resp: { status: 401, text: '' }, old: { status: 401, text: '' } }); await call(w2, {}, { token: 'tok' }); assert.equal(w2.ingested[0].ok, false);
});
await test('특보구역: {zones:true} 면 구역 목록도 받아 넣음. 50개 미만이면 넣지 않음', async () => {
  const w = world(); const r = await call(w, { zones: true }, { token: 'tok' });
  assert.equal(w.zones.length, 1); assert.equal(w.zones[0].length, 65); assert.equal(r.j.zones.changed, 65); assert.equal(w.ingested.length, 1);
  const w2 = world({ reg: { status: 200, text: REG } }); const r2 = await call(w2, { zones: true }, { token: 'tok' });
  assert.equal(w2.zones.length, 0); assert.equal(r2.j.zones.ok, false);
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
