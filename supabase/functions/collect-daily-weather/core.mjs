// 공식 지역대표 반일 원값만 보존. 격자 기온/시간별 예보는 수정하지 않는다.
import {stamp,kstStamp}from '../collect-midterm/core.mjs';
const MAX=2097152,HOUR=3600000;
const fail=s=>{throw Error(s);};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function csv(line){
  const out=[];let v='',quote=false;
  for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){v+='"';i++;}else quote=!quote;}else if(c===','&&!quote){out.push(v.trim());v='';}else v+=c;}
  if(quote)fail('bad_csv');out.push(v.trim());return out;
}
export function parseWeather(text,ids,now){
  if(typeof text!=='string'||text.length>MAX)fail('bad_size');
  const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines[0]!=='#START7777'||lines.at(-1)!=='#7777END')fail('incomplete_response');
  const raw=lines.filter(s=>!s.startsWith('#'));
  if(!raw.length||raw.length>3000)fail('bad_size');
  const allowed=new Set(ids),seen=new Set(),groups=new Map();let issued_at=null;
  const rows=raw.map(line=>{
    const p=csv(line);
    // dl2의 추가 체감온도 열을 dl과 섞지 않는다. 예보관 정보/지역기온 열은 저장하지 않는다.
    if(p.length!==18||p[17]!=='='||!allowed.has(p[0])||p[3]!=='A02')fail('bad_weather_row');
    const issue=stamp(p[1]),forecast_at=stamp(p[2]);
    if(p[1].slice(10)!=='00'||Date.parse(issue)>now+5*60000||Date.parse(issue)<now-36*HOUR)fail('bad_issue');
    if(issued_at&&issued_at!==issue)fail('mixed_issues');issued_at=issue;
    const date=p[2].slice(0,8),issueDate=p[1].slice(0,8),h=p[2].slice(8);
    if(!['0000','1200'].includes(h)||date<issueDate||Date.parse(forecast_at)>Date.parse(stamp(issueDate+'0000'))+4*24*HOUR+12*HOUR)fail('bad_period');
    const sky=['','-99','-999'].includes(p[14])?null:p[14];
    const precip=['','-99','-999'].includes(p[15])?null:p[15];
    const pop=['','-99','-999'].includes(p[13])?null:/^\d{1,3}$/.test(p[13])?Number(p[13]):NaN;
    if((sky!==null&&!['DB01','DB02','DB03','DB04'].includes(sky))||
      (precip!==null&&!['0','1','2','3','4'].includes(precip))||
      (pop!==null&&(!Number.isInteger(pop)||pop>100))||!p[16]||p[16].length>120)fail('bad_weather_value');
    const key=p[0]+'|'+forecast_at;if(seen.has(key))fail('duplicate_row');seen.add(key);
    if(!groups.has(p[0]))groups.set(p[0],[]);groups.get(p[0]).push(forecast_at);
    return{reg_id:p[0],forecast_at,period_hours:12,sky,precip,pop,weather:p[16]};
  });
  if(groups.size!==allowed.size)fail('missing_region');
  let expected=null;
  for(const times of groups.values()){
    times.sort();if(times.length<7||times.length>10||kstStamp(Date.parse(times[0])).slice(0,8)!==kstStamp(Date.parse(issued_at)).slice(0,8)||
      times.some((t,i)=>Date.parse(t)!==Date.parse(times[0])+i*12*HOUR))fail('incomplete_periods');
    const key=times.join('|');if(expected!==null&&expected!==key)fail('incomplete_periods');expected=key;
  }
  return{issued_at,rows};
}
const known=new Set(['bad_size','incomplete_response','bad_csv','bad_weather_row','bad_time','bad_issue','mixed_issues','bad_period','bad_weather_value','duplicate_row','missing_region','incomplete_periods','bad_plan','store_failed','upstream_auth','upstream_unavailable','time_budget']);
export async function handle(req,deps){
  if(req.method!=='POST')return reply(405,{ok:false,error:'post_required'});
  try{const t=req.headers.get('x-collector-token');if(!t||!await deps.tokenOk(t))return reply(401,{ok:false,error:'unauthorized'});}catch{return reply(503,{ok:false,error:'auth_unavailable'});}
  try{const raw=await req.text();if(raw.length>1000)throw Error();const body=JSON.parse(raw||'{}');if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)throw Error();}catch{return reply(400,{ok:false,error:'bad_request'});}
  const start=deps.now(),dailyUsage=new Map();let calls=0,bytes=0,retries=0,result,status=502;
  try{
    const plan=await deps.plan();
    if(!plan||typeof plan.done!=='boolean')fail('bad_plan');
    if(plan.done)return reply(200,{ok:true,skipped:true,calls:0});
    const ids=plan.region_ids;
    if(!Array.isArray(ids)||ids.length<150||ids.length>300||new Set(ids).size!==ids.length||ids.some(s=>typeof s!=='string'||!/^[0-9A-Z]{8}$/.test(s))||
      typeof plan.slot!=='string'||!Number.isFinite(Date.parse(plan.slot))||Date.parse(plan.slot)>deps.now()||Date.parse(plan.slot)<deps.now()-8*HOUR)fail('bad_plan');
    const key=String(deps.env('KMA_AUTH_KEY')||'').trim();if(!key)return reply(503,{ok:false,error:'missing_kma_key'});
    const url=new URL('https://apihub.kma.go.kr/api/typ01/url/fct_afs_dl.php');
    for(const[k,v]of Object.entries({reg:'',disp:'1',help:'1',authKey:key}))url.searchParams.set(k,v);
    let upstream;
    for(let attempt=0;attempt<2;attempt++){
      if(deps.now()-start>45000)fail('time_budget');
      const day=new Date(deps.now()+9*HOUR).toISOString().slice(0,10);
      if(!dailyUsage.has(day))dailyUsage.set(day,{calls:0,bytes:0,retries:0});
      const usage=dailyUsage.get(day);calls++;usage.calls++;if(attempt){retries++;usage.retries++;}
      try{upstream=await deps.fetchText(url.href);}catch{upstream={status:0,text:'',bytes:0};}
      if(Number.isSafeInteger(upstream.bytes)&&upstream.bytes>=0){bytes+=upstream.bytes;usage.bytes+=upstream.bytes;}
      if(upstream.status===200)break;
      if(!attempt&&(upstream.status===0||upstream.status>=500)){await deps.sleep(1000);continue;}
      fail(upstream.status===401||upstream.status===403?'upstream_auth':'upstream_unavailable');
    }
    if(upstream.bytes>MAX)fail('bad_size');
    const parsed=parseWeather(upstream.text,ids,deps.now());
    if(!await deps.put(plan.slot,parsed.issued_at,parsed.rows))fail('store_failed');
    result={ok:true,issued_at:parsed.issued_at,rows:parsed.rows.length};status=200;
  }catch(e){result={ok:false,error:known.has(e?.message)?e.message:'collection_failed'};}
  let usageSaved=false;
  if(calls){usageSaved=true;for(const[day,u]of dailyUsage){try{if(await deps.usage(day,u.calls,u.bytes,u.retries)!==true)usageSaved=false;}catch{usageSaved=false;}}}
  return reply(status,{...result,usage:{calls,bytes,retries,saved:usageSaved}});
}
