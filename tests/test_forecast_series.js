const assert=require('node:assert/strict');
const {combine}=require('../forecast/series.js');
const H=3600000;let n=0;
function test(name,fn){fn();n++;console.log('PASS '+name);}
function sample(h=13){const start=Date.parse('2026-11-05T00:00:00+09:00')+h*H;
 const a=Array.from({length:24},(_,i)=>i%3);
 return {status:'ok',upper:{start_at:new Date(start).toISOString(),series:{s:a,p:a,t:a.map(x=>x-4),r:a.map(x=>x*20),sq:a.map(x=>x===0?1:0),pq:a.map(x=>x===0?1:0)}},tail:{bins:[]}};}
for(let h=0;h<24;h++)test('시작'+h+'시:24시간 누락·중복 없이 KST 정시 정렬',()=>{
 const d=sample(h),bs=combine(d);assert.equal(bs.reduce((s,b)=>s+b.hours,0),24);
 assert.equal(bs.reduce((s,b)=>s+b.pcp,0),24);assert.equal(bs.reduce((s,b)=>s+b.pcp_hi,0),32);
 assert.equal(Date.parse(bs[0].first_at),Date.parse(d.upper.start_at));
 bs.forEach(b=>assert.equal((Date.parse(b.last_at)+9*H)/H%3===0 || b===bs.at(-1),true));
 for(let i=1;i<bs.length;i++)assert.equal(Date.parse(bs[i].first_at)-Date.parse(bs[i-1].last_at),H);
});
test('초단기 혼합 캐시의 값 그대로 합산·최저·최고',()=>{const d=sample();d.upper.series.p[0]=7;const b=combine(d)[0];assert.equal(b.pcp,10);assert.equal(b.tmin,-4);assert.equal(b.pop,40);});
test('24시간 경계의 같은3시간 칸은 합치고 중복하지 않음',()=>{
 const d=sample(14),t=Date.parse(d.upper.start_at)+24*H;
 d.tail.bins=[{first_at:new Date(t).toISOString(),last_at:new Date(t+H).toISOString(),hours:2,snow:4,snow_hi:5,pcp:8,pcp_hi:9,tmin:-9,pop:80}];
 const bs=combine(d),last=bs.at(-1);assert.equal(last.hours,3);assert.equal(last.pcp,10);assert.equal(last.tmin,-9);assert.equal(last.pop,80);
 assert.equal(bs.reduce((s,b)=>s+b.hours,0),26);
});
test('코드·혼합·양 결측인 먼 칸은 기온/확률이 있어도 제외',()=>{const d=sample(),t=Date.parse(d.upper.start_at)+24*H;
 d.tail.bins=[0,1,2].map((i)=>({first_at:new Date(t+i*3*H).toISOString(),last_at:new Date(t+(i*3+2)*H).toISOString(),hours:3,snow:i===2?1:null,pcp:null,pop:90,tmin:4,code_hours:i===1?1:0}));
 assert.deepEqual(combine(d),combine({...d,tail:{bins:[]}}));
});
test('정량0은 시간 칸 유지·미량 상한 유지',()=>{const d=sample();d.upper.series.s.fill(0);d.upper.series.p.fill(0);const bs=combine(d);assert.equal(bs.length,8);assert.equal(bs[0].pcp,0);assert.ok(bs[0].pcp_hi>0);});
test('자정 칸은22~00 양쪽 날짜를 보존',()=>{const b=combine(sample(22))[0];assert.equal(b.hours,3);assert.notEqual(b.first_at.slice(0,10),new Date(Date.parse(b.last_at)+9*H).toISOString().slice(0,10));});
test('빈 이후 자료여도 가까운24시간 유지·입력 불변',()=>{const d=sample(),before=JSON.stringify(d);assert.ok(combine(d).length);assert.equal(JSON.stringify(d),before);assert.deepEqual(combine({status:'stale'}),[]);});
console.log(`${n}/${n} 통과`);
