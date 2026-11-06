// 중기 원자료만 별도로 수집. 인증키/요청주소/원본 오류는 응답이나 로그에 쓰지 않는다.
const BASE='https://apihub.kma.go.kr/api/typ01/url/';
const DAY=86400000, MAX_BYTES=2097152;
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const fail=code=>{throw new Error(code);};
export const kstStamp=ms=>new Date(ms+9*3600000).toISOString().replace(/[-T:]/g,'').slice(0,12);
export function stamp(s){
  if(!/^\d{12}$/.test(s))fail('bad_time');
  const ms=Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8),+s.slice(8,10),+s.slice(10))-9*3600000;
  if(kstStamp(ms)!==s)fail('bad_time');
  return new Date(ms).toISOString();
}
const date=iso=>new Date(Date.parse(iso)+9*3600000).toISOString().slice(0,10);
const dateOffset=(iso,d)=>new Date(Date.parse(date(iso)+'T00:00:00Z')+d*DAY).toISOString().slice(0,10);
const offset=(iso,issue)=>Math.round((Date.parse(date(iso)+'T00:00:00Z')-Date.parse(date(issue)+'T00:00:00Z'))/DAY);
export function latestIssue(now){
  const d=new Date(now-15*60000+9*3600000),h=d.getUTCHours();
  if(h<6){d.setUTCDate(d.getUTCDate()-1);d.setUTCHours(18,0,0,0);}else d.setUTCHours(h>=18?18:6,0,0,0);
  return d.toISOString().replace(/[-T:]/g,'').slice(0,10);
}
function lines(text){
  if(typeof text!=='string'||text.length>MAX_BYTES)fail('bad_size');
  const a=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(a[0]!=='#START7777'||a.at(-1)!=='#7777END')fail('incomplete_response');
  const rows=a.filter(x=>!x.startsWith('#'));
  if(!rows.length||rows.length>5000)fail('bad_size');
  return rows;
}
const code=s=>/^[0-9A-Z]{8}$/.test(s);
function unique(rows,key){const seen=new Set();for(const r of rows){const k=key(r);if(seen.has(k))fail('duplicate_row');seen.add(k);}return rows;}
export function parseRegions(text,issue){
  const rows=lines(text).map(line=>{
    const p=line.match(/^(\S+)\s+(\d{12})\s+(\d{12})\s+(\S+)\s+(.+)$/);
    if(!p||!code(p[1])||!['A','C','H','I','0'].includes(p[4])||p[5].length>120)fail('bad_region');
    const valid_from=stamp(p[2]),valid_to=stamp(p[3]);if(valid_from>=valid_to)fail('bad_region');
    return {reg_id:p[1],valid_from,valid_to,type:p[4],name:p[5]};
  });
  unique(rows,r=>r.reg_id);
  const active=rows.filter(r=>r.valid_from<=issue&&issue<r.valid_to),land=active.filter(r=>r.type==='A');
  const landIds=land.filter(r=>!land.some(c=>c.reg_id!==r.reg_id&&c.reg_id.startsWith(r.reg_id.replace(/0+$/,'')))).map(r=>r.reg_id);
  const tempIds=active.filter(r=>r.type==='C').map(r=>r.reg_id);
  if(landIds.length<10||tempIds.length<150)fail('incomplete_regions');
  return {rows,landIds,tempIds};
}
function csv(line){
  // 기상청 disp=1의 쉼표 구분. 따옴표 안의 쉼표/이스케이프도 처리한다.
  const out=[];let value='',quoted=false;
  for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){out.push(value.trim());value='';}else value+=c;}
  if(quoted)fail('bad_csv');out.push(value.trim());return out;
}
function number(s,min,max){
  if(['-999','-99','-99.9',''].includes(s))return null;
  if(!/^-?\d+(\.\d+)?$/.test(s))fail('bad_number');
  const n=Number(s);if(!Number.isFinite(n)||n<min||n>max)fail('bad_number');return n;
}
function coverage(rows,ids,issue,land){
  const groups=new Map();for(const r of rows){if(!ids.includes(r.reg_id))fail('unknown_region');if(!groups.has(r.reg_id))groups.set(r.reg_id,[]);groups.get(r.reg_id).push(r);}
  if(groups.size!==ids.length)fail('missing_region');
  const first=Math.min(...rows.map(r=>land?offset(r.forecast_at,issue):Math.round((Date.parse(r.date+'T00:00Z')-Date.parse(date(issue)+'T00:00Z'))/DAY)));
  if(first!==4&&first!==5)fail('bad_forecast_window');
  const expected=[];
  for(let d=first;d<=10;d++){const day=dateOffset(issue,d);expected.push(day+'|00');if(land&&d<=7)expected.push(day+'|12');}
  for(const group of groups.values()){
    const got=new Set(group.map(r=>land?date(r.forecast_at)+'|'+kstStamp(Date.parse(r.forecast_at)).slice(8,10):r.date+'|00'));
    if(got.size!==group.length||got.size!==expected.length||expected.some(k=>!got.has(k)))fail('incomplete_forecast');
  }
}
export function parseLand(text,issue,ids){
  const issueText=kstStamp(Date.parse(issue));
  const rows=lines(text).map(line=>{
    const p=csv(line);if(p.length!==12||p[11]!=='='||!code(p[0])||p[1]!==issueText)fail('bad_land_row');
    const forecast_at=stamp(p[2]),d=offset(forecast_at,issue),h=p[2].slice(8);
    const period_hours=p[3]==='A02'?12:p[3]==='A01'?24:0;
    if(!period_hours||!(h==='0000'||(period_hours===12&&h==='1200'))||d<4||d>10||period_hours!==(d<=7?12:24))fail('bad_period');
    if(!['WB00','WB01','WB02','WB03','WB04'].includes(p[6])||!['WB00','WB09','WB11','WB12','WB13'].includes(p[7])||p[9].length>120)fail('bad_weather');
    const pop=number(p[10],0,100);if(pop!==null&&!Number.isInteger(pop))fail('bad_probability');
    return {reg_id:p[0],forecast_at,period_hours,sky:p[6]==='WB00'?null:p[6],precip:p[7],weather:p[9],pop};
  });
  unique(rows,r=>r.reg_id+'|'+r.forecast_at);coverage(rows,ids,issue,true);return rows;
}
export function parseTemperature(text,issue,ids){
  const issueText=kstStamp(Date.parse(issue));
  const rows=lines(text).map(line=>{
    const p=csv(line);if(p.length!==13||p[12]!=='='||!code(p[0])||p[1]!==issueText||p[3]!=='A01'||p[2].slice(8)!=='0000')fail('bad_temperature_row');
    const at=stamp(p[2]),d=offset(at,issue);if(d<4||d>10)fail('bad_forecast_window');
    // 아침 최저와 낮 최고는 서로 다른 시간대다. 크기 순서로 정상 자료를 거부하지 않는다.
    const tmin=number(p[6],-70,60),tmax=number(p[7],-70,60);
    return {reg_id:p[0],date:date(at),tmin,tmax};
  });
  unique(rows,r=>r.reg_id+'|'+r.date);coverage(rows,ids,issue,false);return rows;
}
export async function handle(req,deps){
  if(req.method!=='POST')return json(405,{ok:false,error:'post_required'});
  try{const t=req.headers.get('x-collector-token');if(!t||!await deps.tokenOk(t))return json(401,{ok:false,error:'unauthorized'});}catch{return json(503,{ok:false,error:'auth_unavailable'});}
  let body;try{const t=await req.text();if(t.length>1000)return json(400,{ok:false,error:'bad_request'});body=JSON.parse(t||'{}');}catch{return json(400,{ok:false,error:'bad_json'});}
  const now=deps.now(),target=body?.issue??latestIssue(now),kinds=body?.kinds??['land','temperature'];
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['issue','kinds'].includes(k))||typeof target!=='string'||!/^\d{8}(06|18)$/.test(target)||!Array.isArray(kinds)||!kinds.length||new Set(kinds).size!==kinds.length||kinds.some(k=>!['land','temperature'].includes(k)))return json(400,{ok:false,error:'bad_request'});
  let issue;try{issue=stamp(target+'00');}catch{return json(400,{ok:false,error:'bad_issue'});}
  if(Date.parse(issue)>now+5*60000||Date.parse(issue)<now-36*3600000)return json(400,{ok:false,error:'bad_issue'});
  const key=String(deps.env('KMA_AUTH_KEY')||'').trim();if(!key)return json(503,{ok:false,error:'missing_kma_key'});
  const start=deps.now(),results=[];
  async function fetchKind(kind){
    const url=new URL(BASE+(kind==='regions'?'fct_medm_reg.php':kind==='land'?'fct_afs_wl.php':'fct_afs_wc.php'));
    const params=kind==='regions'?{tmfc:'0'}:{reg:'',tmfc1:target,tmfc2:target,disp:'1',help:'1'};
    for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);url.searchParams.set('authKey',key);
    for(let attempt=0;attempt<2;attempt++){
      if(deps.now()-start>100000)fail('time_budget');
      let r;try{r=await deps.fetchText(url.href);}catch{r={status:0,text:''};}
      if(r.status===200){if(r.bytes>MAX_BYTES)fail('bad_size');return r;}
      if(!attempt&&(r.status===0||r.status>=500)){await deps.sleep(1500);continue;}
      const error=new Error(r.status===401||r.status===403?'upstream_auth':'upstream_unavailable');
      error.upstream_status=r.status;throw error;
    }
  }
  let catalog;
  try{const r=await fetchKind('regions');catalog=parseRegions(r.text,issue);if(!await deps.put('regions',new Date(deps.now()).toISOString(),catalog.rows))fail('store_failed');results.push({kind:'regions',rows:catalog.rows.length,bytes:r.bytes,ok:true});}
  catch(e){return json(502,{ok:false,issue,results:[failure('regions',e)]});}
  for(const kind of kinds){
    try{const r=await fetchKind(kind),rows=kind==='land'?parseLand(r.text,issue,catalog.landIds):parseTemperature(r.text,issue,catalog.tempIds);
      if(!await deps.put(kind,issue,rows))fail('store_failed');results.push({kind,rows:rows.length,bytes:r.bytes,ok:true});
    }catch(e){results.push(failure(kind,e));}
  }
  const ok=results.every(r=>r.ok);return json(ok?200:502,{ok,issue,results});
}
function failure(kind,e){const r={kind,ok:false,error:known(e)};if(Number.isInteger(e?.upstream_status)&&e.upstream_status>=0&&e.upstream_status<=599)r.upstream_status=e.upstream_status;return r;}
function known(e){return ['bad_time','bad_size','incomplete_response','bad_region','duplicate_row','incomplete_regions','bad_csv','bad_number','unknown_region','missing_region','bad_forecast_window','incomplete_forecast','bad_land_row','bad_period','bad_weather','bad_probability','bad_temperature_row','bad_temperature_range','time_budget','store_failed','upstream_auth','upstream_unavailable'].includes(e?.message)?e.message:'collection_failed';}
