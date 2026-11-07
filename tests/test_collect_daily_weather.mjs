import assert from 'node:assert/strict';
import fs from 'node:fs';
import{parseWeather,handle}from '../supabase/functions/collect-daily-weather/core.mjs';
const tests=[];async function test(name,fn){try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:e.message});}}
const NOW=Date.parse('2026-11-07T00:00:00+09:00'),ids=Array.from({length:150},(_,i)=>String(i).padStart(8,'0'));
const slot='2026-11-06T14:00:00Z';
function line(id,t,i='202611061700'){return[id,i,t,'A02',0,108,0,'ignored-id','ignored-name','N','-','N',-99,0,'DB01',0,'맑음','='].join(',');}
const times=Array.from({length:9},(_,i)=>new Date(Date.parse('2026-11-06T12:00:00+09:00')+i*43200000+32400000).toISOString().replace(/[-T:]/g,'').slice(0,12));
const rows=ids.flatMap(id=>times.map(t=>line(id,t)));
const frame=r=>'#START7777\n# headers\n'+r.join('\n')+'\n#7777END';
const parse=r=>parseWeather(frame(r),ids,NOW);
function world(extra={}){
 const w={calls:[],puts:[],usage:[],queue:[{status:200,text:frame(rows)}],plan:{done:false,slot,region_ids:ids},key:'example/key+value',...extra};
 w.deps={now:()=>NOW,tokenOk:async t=>t==='collector',env:()=>w.key,sleep:async()=>{},plan:async()=>w.plan,
   fetchText:async url=>{w.calls.push(url);const r=w.queue.shift();if(r instanceof Error)throw r;return{...r,bytes:r?.text?.length??0};},
   put:async(...a)=>{w.puts.push(a);return true;},usage:async(...a)=>{w.usage.push(a);return true;}};return w;
}
const req=(b={},token='collector',method='POST')=>new Request('https://test.invalid',{method,headers:token?{'x-collector-token':token}:{},...(method==='POST'?{body:JSON.stringify(b)}:{})});
const run=async(w,b={})=>(await handle(req(b),w.deps)).json();
await test('실제 API 6지역 54반일 표본·개인정보 제외',()=>{
 const text=fs.readFileSync(new URL('./fixtures/shortland_2026110617.txt',import.meta.url),'utf8');
 const sampleIds=[...new Set(text.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',')[0].trim()))];
 const r=parseWeather(text,sampleIds,NOW);assert.equal(r.rows.length,54);assert.equal(r.rows.find(r=>r.reg_id==='21F20802'&&r.forecast_at==='2026-11-06T15:00:00.000Z').pop,0);assert(!JSON.stringify(r).includes('omitted'));
});
await test('150지역 9반일·확률0 보존·지역기온/예보관 제외',()=>{
 const r=parse(rows);assert.equal(r.rows.length,1350);assert.equal(r.issued_at,'2026-11-06T08:00:00.000Z');assert.equal(r.rows[0].pop,0);
 assert.deepEqual(Object.keys(r.rows[0]),['reg_id','forecast_at','period_hours','sky','precip','pop','weather']);assert(!JSON.stringify(r).includes('ignored'));
});
await test('오전 발표 10반일도 허용·고정9개 가정 없음',()=>{
 const start=Date.parse('2026-11-06T00:00:00+09:00');const a=ids.flatMap(id=>Array.from({length:10},(_,i)=>line(id,new Date(start+i*43200000+32400000).toISOString().replace(/[-T:]/g,'').slice(0,12),'202611060500')));assert.equal(parse(a).rows.length,1500);
});
await test('절단·HTML·종료표식 없음 거부',()=>{for(const s of[frame(rows).slice(0,-5),'<html>error</html>','#START7777\n#7777END'])assert.throws(()=>parseWeather(s,ids,NOW));});
await test('한 지역 누락·알 수 없는 지역·중복행 거부',()=>{for(const a of[rows.slice(9),[...rows,line('UNKNOWN0',times[0])],[...rows,rows[0]]])assert.throws(()=>parse(a));});
await test('한 반일 누락·구간 중간 공백 거부',()=>{assert.throws(()=>parse(rows.slice(1)),/incomplete_periods/);assert.throws(()=>parse(rows.filter((_,i)=>i%9!==4)),/incomplete_periods/);});
await test('발표 혼합·미래/오래된 발표·잘못된 달력 거부',()=>{for(const issue of['202611061100','202611080500','202611041700','202613061700'])assert.throws(()=>parse([line(ids[0],times[0],issue),...rows.slice(1)]));});
await test('dl2 열 추가·24시간모드·정오 이외 시각 거부',()=>{for(const s of[rows[0].replace(',-99,',',-99,-99,'),rows[0].replace('A02','A01'),rows[0].replace('202611061200','202611061300')])assert.throws(()=>parse([s,...rows.slice(1)]));});
await test('결측null·비/눈·쉼표 포함 날씨 보존',()=>{
 const p=rows[0].split(',');p[13]='-99';p[14]='-99';p[15]='2';p[16]='"비, 눈"';const r=parse([p.join(','),...rows.slice(1)]).rows[0];assert.equal(r.pop,null);assert.equal(r.sky,null);assert.equal(r.precip,'2');assert.equal(r.weather,'비, 눈');
});
await test('확률 범위/문자열·알 수 없는 기상코드 거부',()=>{for(const [i,v]of[[13,'101'],[13,'NaN'],[14,'DB99'],[15,'7'],[16,'']]){const p=rows[0].split(',');p[i]=v;assert.throws(()=>parse([p.join(','),...rows.slice(1)]));}});
await test('인증/메서드 검사·임의 URL/기간 입력 거부',async()=>{
 const w=world();assert.equal((await handle(req({},'', 'POST'),w.deps)).status,401);assert.equal((await handle(req({},'bad'),w.deps)).status,401);assert.equal((await handle(req({},'collector','GET'),w.deps)).status,405);
 for(const b of[null,[],{url:'https://evil.invalid'},{issue:'2026110617'}])assert.equal((await handle(req(b),w.deps)).status,400);assert.equal(w.calls.length,0);
});
await test('최신조회 한 번·원값 저장·키/원문/직원정보 응답 제외',async()=>{
 const w=world(),r=await run(w);assert(r.ok);assert.equal(r.rows,1350);assert.equal(w.calls.length,1);const u=new URL(w.calls[0]);assert(u.pathname.endsWith('/fct_afs_dl.php'));assert(!u.searchParams.has('tmfc1'));assert.equal(u.searchParams.get('authKey'),w.key);assert.equal(w.puts.length,1);assert(!JSON.stringify(r).includes(w.key));assert.equal(w.usage[0][1],1);
});
await test('완료 구간은 API/키 조회 없이 건너뜀',async()=>{const w=world({plan:{done:true}});w.deps.env=()=>{throw Error('must not read key');};assert((await run(w)).skipped);assert.equal(w.calls.length,0);});
await test('잘못된 계획/지역목록은 API 전 거부',async()=>{
 for(const p of[{region_ids:[]},{region_ids:[...ids,ids[0]]},{slot:'tomorrow'},{slot:'2026-11-01T00:00:00Z'},{done:'false'},{region_ids:[...ids.slice(1),'bad_____']}]){const w=world({plan:{done:false,slot,region_ids:ids,...p}});assert.equal((await run(w)).error,'bad_plan');assert.equal(w.calls.length,0);}
});
await test('403은 재시도/성공저장 없이 종료',async()=>{const w=world({queue:[{status:403,text:'example/key+value'}]});const r=await run(w);assert.equal(r.error,'upstream_auth');assert.equal(w.calls.length,1);assert.equal(w.puts.length,0);assert(!JSON.stringify(r).includes(w.key));});
await test('5xx/네트워크 실패는 한 번 재시도·계측',async()=>{for(const error of[{status:503,text:''},new Error('secret')]){const w=world();w.queue.unshift(error);const r=await run(w);assert(r.ok);assert.equal(r.usage.calls,2);assert.equal(r.usage.retries,1);}});
await test('HTTP200 오류/절단 응답은 정상 캐시/완료 처리 안 함',async()=>{const w=world({queue:[{status:200,text:'# ERROR'}]});assert.equal((await run(w)).error,'incomplete_response');assert.equal(w.puts.length,0);});
await test('DB 저장 실패는 성공으로 표시 안 함',async()=>{const w=world();w.deps.put=async()=>false;assert.equal((await run(w)).error,'store_failed');});
await test('사용량 기록 실패와 수집 결과 구분',async()=>{const w=world();w.deps.usage=async()=>{throw Error(w.key);};const r=await run(w);assert(r.ok);assert.equal(r.usage.saved,false);});
await test('재시도 중 한국 자정이 지나면 사용량 날짜 분리',async()=>{
 const w=world();let now=NOW-500;w.deps.now=()=>now;w.deps.sleep=async ms=>{now+=ms;};w.queue.unshift({status:503,text:''});assert((await run(w)).ok);assert.deepEqual(w.usage.map(a=>a[0]),['2026-11-06','2026-11-07']);assert.deepEqual(w.usage.map(a=>a[1]),[1,1]);
});
await test('인증/DB 오류에 비밀이 있어도 응답에 반사 안 함',async()=>{const w=world();w.deps.plan=async()=>{throw Error(w.key);};assert.equal((await run(w)).error,'collection_failed');w.deps.tokenOk=async()=>{throw Error(w.key);};assert.equal((await handle(req(),w.deps)).status,503);});
for(const t of tests)console.log(`${t.ok?'PASS':'FAIL'} ${t.name}${t.error?' — '+t.error:''}`);const n=tests.filter(t=>t.ok).length;console.log(`${n}/${tests.length} 통과`);process.exitCode=n===tests.length?0:1;
