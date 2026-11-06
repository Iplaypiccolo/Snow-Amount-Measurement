import assert from 'node:assert/strict';
import { issue, requestFor, handle } from '../supabase/functions/probe-daily-forecast/core.mjs';
const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch(e) { results.push([name, false, e.message]); } }
const now = Date.parse('2026-11-06T16:00:00+09:00');
function world(extra = {}) {
  const w = { calls: [], key: 'secret/K+example', text: '# header\n11B00000,2026110606,맑음,10', status: 200, ...extra };
  w.deps = { now: () => now, env: () => w.key, tokenOk: async t => t === 'collector',
    fetchText: async u => { w.calls.push(u); return { status: w.status, text: w.text, bytes: w.text.length }; } };
  return w;
}
const req = (body = { kind: 'land' }, token = 'collector', method = 'POST') => new Request('https://test.invalid', {
  method, headers: token ? { 'x-collector-token': token } : {}, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
await test('중기 최근06시 발표 선택', () => assert.equal(issue(now), '2026110606'));
await test('중기 생산 직후 이전 발표 유지', () => assert.equal(issue(Date.parse('2026-11-06T18:10:00+09:00')), '2026110606'));
await test('중기 자정 이전 날짜18시 선택', () => assert.equal(issue(Date.parse('2026-11-06T00:10:00+09:00')), '2026110518'));
await test('단기14시 선택', () => assert.equal(issue(now, false), '2026110614'));
await test('단기 연말 경계', () => assert.equal(issue(Date.parse('2027-01-01T00:10:00+09:00'), false), '2026123120'));
await test('모르는 종류는 요청 없음', () => assert.equal(requestFor('https://evil.invalid', now), null));
await test('구역 목록은 최신만', () => assert.deepEqual(requestFor('regions', now).params, { tmfc: '0' }));
await test('최저/최고기온 다음날06/15시', () => {
  assert.equal(requestFor('TMN', now).params.tmef, '2026110706');
  assert.equal(requestFor('TMX', now).params.tmef, '2026110715');
});
await test('인증 없이 API 호출 안 함', async () => { const w = world(); assert.equal((await handle(req({}, ''), w.deps)).status, 401); assert.equal(w.calls.length, 0); });
await test('틀린 토큰 거부', async () => { const w = world(); assert.equal((await handle(req({}, 'wrong'), w.deps)).status, 401); });
await test('GET 거부', async () => assert.equal((await handle(req({}, '', 'GET'), world().deps)).status, 405));
await test('임의 URL/발표시각 입력 거부', async () => { const w = world(); assert.equal((await handle(req({ kind: 'land', url: 'https://evil.invalid' }), w.deps)).status, 400); assert.equal(w.calls.length, 0); });
await test('키 없으면 호출 안 함', async () => { const w = world({ key: '' }); assert.equal((await handle(req(), w.deps)).status, 503); assert.equal(w.calls.length, 0); });
await test('키는 요청 서버에만 첨부', async () => { const w = world(); const b = await (await handle(req(), w.deps)).json(); assert.equal(b.ok, true); assert.equal(new URL(w.calls[0]).searchParams.get('authKey'), w.key); assert(!JSON.stringify(b).includes(w.key)); });
await test('기존 수집기와 같이 키 앞뒤 공백 제거', async () => { const w = world({ key: ' secret/K+example\r\n' }); await handle(req(), w.deps); assert.equal(new URL(w.calls[0]).searchParams.get('authKey'), w.key.trim()); });
await test('폼 인코딩된 키 반사도 제거', async () => { const w = world({ key: "secret~with!punctuation'" }); const encoded = new URLSearchParams({authKey:w.key}).toString().slice(8); w.text = '<html>' + encoded + '</html>'; const b = await (await handle(req(),w.deps)).json(); assert(!b.text.includes(encoded)); });
await test('API 오류 키 반사 제거', async () => { const w = world(); w.text = '<html>ERROR ' + w.key + ' ' + encodeURIComponent(w.key) + '</html>'; const b = await (await handle(req(), w.deps)).json(); assert.equal(b.ok, false); assert(!JSON.stringify(b).includes(w.key)); assert(!JSON.stringify(b).includes(encodeURIComponent(w.key))); });
await test('통신 예외 주소/키 미출력', async () => { const w = world(); w.deps.fetchText = async () => { throw new Error(w.key); }; const r = await handle(req(), w.deps); assert.equal(r.status, 502); assert(!(await r.text()).includes(w.key)); });
await test('미제공 격자는 성공으로 처리 안 함', async () => { const w = world({ text: '# dfs_file_read error' }); const b = await (await handle(req({ kind: 'SKY' }), w.deps)).json(); assert.equal(b.ok, false); });
await test('유효 격자 요약만 반환', async () => { const w = world({ text: Array(149 * 253).fill('1').join(',') }); const b = await (await handle(req({ kind: 'SKY' }), w.deps)).json(); assert.equal(b.ok, true); assert.equal(b.stats.n, 37697); assert.equal(b.text, undefined); });
await test('큰 응답 절단 표시', async () => { const w = world({ text: '11B00000,' + 'x'.repeat(90000) }); const b = await (await handle(req(), w.deps)).json(); assert.equal(b.truncated, true); assert.equal(b.text.length, 80000); });
await test('공식구역정보JSON·페이지요청', () => { const s=requestFor('zones',now,{page:2});assert.equal(s.params.pageNo,'2');assert.equal(s.params.numOfRows,'1000');assert(s.url.endsWith('/FcstZoneInfoService/getFcstZoneCd')); });
await test('구역코드와페이지범위검사', () => { assert.equal(requestFor('zones',now,{page:21}),null);assert.equal(requestFor('zones',now,{regId:'../secret'}),null);assert.equal(requestFor('zones',now,{page:'2'}),null); });
await test('좌표·상위구역·전체개수해석', async () => {const w=world({text:JSON.stringify({response:{header:{resultCode:'00'},body:{totalCount:2,items:{item:[{regId:'11B10101',regName:'서울',regSp:'C',regUp:'11B00000',lat:'37.57',lon:'126.97',tmSt:'199001010000',tmEd:'210012310000'}]}}}})});const b=await(await handle(req({kind:'zones',page:1}),w.deps)).json();assert(b.ok);assert.equal(b.totalCount,2);assert.equal(b.items[0].lat,37.57);assert.equal(b.items[0].regUp,'11B00000');});
await test('구역단일객체도배열로해석', async()=>{const w=world({text:JSON.stringify({response:{header:{resultCode:'00'},body:{totalCount:1,items:{item:{regId:'11B00000',lat:0,lon:0}}}}})});const b=await(await handle(req({kind:'zones',regId:'11B00000'}),w.deps)).json();assert(b.ok);assert.equal(b.items[0].lat,null);});
await test('구역API오류에서키가리기',async()=>{const w=world();w.text=JSON.stringify({response:{header:{resultCode:'30',resultMsg:w.key}}});const b=await(await handle(req({kind:'zones'}),w.deps)).json();assert.equal(b.ok,false);assert(!JSON.stringify(b).includes(w.key));});
await test('구역API임의주소입력거부',async()=>{const w=world();assert.equal((await handle(req({kind:'zones',url:'https://evil.invalid'}),w.deps)).status,400);assert.equal(w.calls.length,0);});
for (const [n, ok, e] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${e ? ': ' + e : ''}`);
const passed = results.filter(r => r[1]).length;
console.log(`${passed}/${results.length} 통과`);
process.exitCode = passed === results.length ? 0 : 1;
