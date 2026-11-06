import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {handle,latestIssue,stamp,parseRegions,parseLand,parseTemperature} from '../supabase/functions/collect-midterm/core.mjs';
const results=[];
async function test(name,fn){try{await fn();results.push([name,true]);}catch(e){results.push([name,false,e.message]);}}
const A=['11B00000','11C10000','11C20000','11D10000','11D20000','11F10000','11F20000','11G00000','11H10000','11H20000','11I00000','11J10000','11J20000','11K10000','11K20000'];
const C=Array.from({length:203},(_,i)=>'11Z'+String(i).padStart(5,'0'));
const frame=rows=>'#START7777\n# synthetic protocol fixture\n'+rows.join('\n')+'\n#7777END\n';
function fixture(target='2026110606',first=4){
  const meta=[...A,...['11C00000','11F00000','11H00000']].map(x=>[x,'A','육상']);
  meta.push(...C.map(x=>[x,'C','도시']),...Array.from({length:16},(_,i)=>['12A'+String(i).padStart(5,'0'),'H','해상']),['12F00100','I','규슈서해'],['12F00200','I','규슈남해'],['11BD0000','0','통합구역']);
  const regions=frame(meta.map(([id,type,name])=>`${id} 199001010000 210012310000 ${type} ${name}`));
  const day=d=>new Date(Date.UTC(2026,10,6+d)).toISOString().slice(0,10).replace(/-/g,'');
  const land=[],temp=[];
  for(const id of A)for(let d=first;d<=10;d++)for(const h of d<=7?['00','12']:['00'])land.push([id,target+'00',day(d)+h+'00',d<=7?'A02':'A01','109','2','WB01','WB00','없음','맑음','10','='].join(','));
  for(const id of C)for(let d=first;d<=10;d++)temp.push([id,target+'00',day(d)+'0000','A01','109','2','0','10','1','1','2','2','='].join(','));
  return {regions,land:frame(land),temperature:frame(temp)};
}
const F=fixture(),ISSUE=stamp('202611060600'),CAT=parseRegions(F.regions,ISSUE);
function world(extra={}){
  const w={key:' secret/K+test\r\n',clock:Date.parse('2026-11-06T16:00:00+09:00'),calls:[],puts:[],responses:{...F},...extra};
  w.deps={now:()=>w.clock,env:()=>w.key,tokenOk:async t=>t==='collector',sleep:async ms=>{w.clock+=ms;},
    fetchText:async u=>{w.calls.push(u);const k=u.includes('fct_medm_reg')?'regions':u.includes('fct_afs_wl')?'land':'temperature';return {status:200,text:w.responses[k],bytes:new TextEncoder().encode(w.responses[k]).length};},
    put:async (kind,issue,rows)=>{w.puts.push({kind,issue,rows});return kind!==w.failKind;}};
  return w;
}
const request=(body={},token='collector')=>new Request('https://test.invalid',{method:'POST',headers:token?{'x-collector-token':token}:{},body:JSON.stringify(body)});
await test('발표15분후06시 선택',()=>assert.equal(latestIssue(Date.parse('2026-11-06T06:15:00+09:00')),'2026110606'));
await test('생산직후 이전18시 선택',()=>assert.equal(latestIssue(Date.parse('2026-11-06T06:14:00+09:00')),'2026110518'));
await test('잘못된 달력 날짜 거부',()=>assert.throws(()=>stamp('202602300600')));
await test('구역240개,상위통합A제외후육상15개',()=>{assert.equal(CAT.rows.length,240);assert.equal(CAT.landIds.length,15);assert.equal(CAT.tempIds.length,203);assert(CAT.rows.some(r=>r.type==='I'));assert(CAT.rows.some(r=>r.type==='0'));});
await test('육상165칸의반일/일단위구분',()=>{const r=parseLand(F.land,ISSUE,CAT.landIds);assert.equal(r.length,165);assert.equal(r.filter(x=>x.period_hours===24).length,45);});
await test('8만글자초과 기온1421행을끝까지해석',()=>{assert(F.temperature.length>80000);assert.equal(parseTemperature(F.temperature,ISSUE,CAT.tempIds).length,1421);});
await test('기온0과결측구분',()=>{const text=F.temperature.replace(',0,10,',',0,-999,');const r=parseTemperature(text,ISSUE,CAT.tempIds);assert.equal(r[0].tmin,0);assert.equal(r[0].tmax,null);});
await test('끝표식이잘린응답거부',()=>assert.throws(()=>parseLand(F.land.slice(0,-12),ISSUE,CAT.landIds),/incomplete_response/));
await test('도시한곳전체누락거부',()=>assert.throws(()=>parseTemperature(F.temperature.split('\n').filter(l=>!l.startsWith(C[0]+',')).join('\n'),ISSUE,CAT.tempIds),/missing_region/));
await test('한시각누락거부',()=>{const r=F.land.split('\n');r.splice(2,1);assert.throws(()=>parseLand(r.join('\n'),ISSUE,CAT.landIds),/incomplete_forecast/);});
await test('중복시각거부',()=>assert.throws(()=>parseLand(F.land.replace('#7777END',F.land.split('\n')[2]+'\n#7777END'),ISSUE,CAT.landIds),/duplicate_row/));
await test('다른발표혼입거부',()=>assert.throws(()=>parseLand(F.land.replace('202611060600','202611051800'),ISSUE,CAT.landIds),/bad_land_row/));
await test('잘못된하늘코드거부',()=>assert.throws(()=>parseLand(F.land.replace('WB01','WB99'),ISSUE,CAT.landIds),/bad_weather/));
await test('확률범위검사',()=>assert.throws(()=>parseLand(F.land.replace(',10,=',',101,='),ISSUE,CAT.landIds),/bad_number/));
await test('아침최저가낮최고보다높아도원값보존',()=>{const r=parseTemperature(F.temperature.replace(',0,10,',',20,10,'),ISSUE,CAT.tempIds);assert.equal(r[0].tmin,20);assert.equal(r[0].tmax,10);});
await test('따옴표안쉼표지원',()=>assert.equal(parseLand(F.land.replace(',맑음,',',"맑음, 점차 흐림",'),ISSUE,CAT.landIds)[0].weather,'맑음, 점차 흐림'));
await test('18시발표+5일부터시작하는6일자료지원',()=>{const f=fixture('2026110618',5),i=stamp('202611061800');assert.equal(parseLand(f.land,i,CAT.landIds).length,135);assert.equal(parseTemperature(f.temperature,i,CAT.tempIds).length,1218);});
await test('인증실패시호출/저장없음',async()=>{const w=world();assert.equal((await handle(request({},''),w.deps)).status,401);assert.equal(w.calls.length,0);assert.equal(w.puts.length,0);});
await test('임의주소입력거부',async()=>assert.equal((await handle(request({url:'https://evil.invalid'}),world().deps)).status,400));
await test('정상3종저장과공백제거',async()=>{const w=world();const b=await(await handle(request(),w.deps)).json();assert(b.ok);assert.deepEqual(w.puts.map(x=>x.kind),['regions','land','temperature']);assert.equal(w.puts[2].rows.length,1421);assert.equal(new URL(w.calls[0]).searchParams.get('authKey'),w.key.trim());assert(!JSON.stringify(b).includes(w.key.trim()));});
await test('완료한종류를재요청하지않음',async()=>{const w=world();const b=await(await handle(request({kinds:['temperature']}),w.deps)).json();assert(b.ok);assert.equal(w.calls.length,2);assert.deepEqual(w.puts.map(x=>x.kind),['regions','temperature']);});
await test('200오류페이지와키반사미출력',async()=>{const w=world();w.responses.regions='<html>'+w.key+'</html>';const r=await handle(request(),w.deps),s=await r.text();assert.equal(r.status,502);assert(!s.includes(w.key.trim()));assert.equal(w.puts.length,0);});
await test('구역저장실패시본문호출안함',async()=>{const w=world({failKind:'regions'});assert.equal((await handle(request(),w.deps)).status,502);assert.equal(w.calls.length,1);});
await test('500응답한번재시도후성공',async()=>{const w=world(),original=w.deps.fetchText;let once=false;w.deps.fetchText=async u=>{if(u.includes('fct_afs_wl')&&!once){once=true;w.calls.push(u);return {status:500,text:''};}return original(u);};assert.equal((await handle(request(),w.deps)).status,200);assert.equal(w.calls.length,4);});
await test('불완전육상은저장안하고정상기온은저장',async()=>{const w=world();w.responses.land=F.land.slice(0,-12);const b=await(await handle(request(),w.deps)).json();assert.equal(b.ok,false);assert.deepEqual(w.puts.map(x=>x.kind),['regions','temperature']);});
await test('인증오류반복재시도안함',async()=>{const w=world();w.deps.fetchText=async u=>{w.calls.push(u);return {status:403,text:'private upstream text'};};const r=await handle(request(),w.deps);assert.equal(r.status,502);assert.equal(w.calls.length,1);assert(!(await r.text()).includes('private upstream'));});
await test('예외원문미출력',async()=>{const w=world();w.deps.put=async()=>{throw Error(w.key);};const b=await(await handle(request(),w.deps)).text();assert(!b.includes(w.key.trim()));});
await test('오래된발표요청거부',async()=>assert.equal((await handle(request({issue:'2026110106'}),world().deps)).status,400));
await test('HTTP오류는상태숫자만반환',async()=>{const w=world();w.deps.fetchText=async()=>({status:404,text:w.key});const b=await(await handle(request(),w.deps)).json();assert.equal(b.results[0].upstream_status,404);assert(!JSON.stringify(b).includes(w.key.trim()));});
await test('통신예외는상태0만반환',async()=>{const w=world();w.deps.fetchText=async()=>{throw Error(w.key);};const b=await(await handle(request(),w.deps)).json();assert.equal(b.results[0].upstream_status,0);assert(!JSON.stringify(b).includes(w.key.trim()));});
await test('실제TypeScript진입점의인증→전체수집→RPC저장연결',()=>{const r=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./_midterm_adapter_probe.mjs',import.meta.url))],{input:JSON.stringify(F),encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);});
for(const [n,ok,e]of results)console.log(`${ok?'PASS':'FAIL'} ${n}${e?': '+e:''}`);
const passed=results.filter(x=>x[1]).length;console.log(`${passed}/${results.length} 통과`);process.exitCode=passed===results.length?0:1;
