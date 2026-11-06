// Node의TypeScript실행으로실제진입점까지연결. 네트워크/키/DB는가짜이며외부호출없음.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const fixtures=JSON.parse(fs.readFileSync(0,'utf8')),puts=[];let serve;
Date.now=()=>Date.parse('2026-11-06T16:00:00+09:00');
globalThis.Deno={env:{get:k=>({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'dummy-service-key',KMA_AUTH_KEY:' dummy-weather-key\r\n'})[k]},serve:fn=>{serve=fn;}};
globalThis.fetch=async(input,options)=>{
  const url=new URL(input);
  if(url.hostname==='db.invalid'){
    assert.equal(options.headers.apikey,'dummy-service-key');
    const body=JSON.parse(options.body);
    if(url.pathname.endsWith('collector_token_ok'))return Response.json(body.t==='collector');
    if(url.pathname.endsWith('forecast_midterm_put')){puts.push(body);return Response.json(true);}
  }
  if(url.hostname==='apihub.kma.go.kr'){
    assert.equal(url.searchParams.get('authKey'),'dummy-weather-key');
    const kind=url.pathname.endsWith('fct_medm_reg.php')?'regions':url.pathname.endsWith('fct_afs_wl.php')?'land':url.pathname.endsWith('fct_afs_wc.php')?'temperature':null;
    assert(kind);return new Response(fixtures[kind],{status:200});
  }
  throw Error('unexpected network target');
};
await import('../supabase/functions/collect-midterm/index.ts');
const unauthorized=await serve(new Request('https://function.invalid',{method:'POST',body:'{}'}));
assert.equal(unauthorized.status,401);
const r=await serve(new Request('https://function.invalid',{method:'POST',headers:{'x-collector-token':'collector'},body:'{}'}));
const b=await r.json();assert.equal(r.status,200);assert.equal(b.ok,true);assert.equal(puts.length,3);
assert.equal(puts[2].p_payload.length,1421);assert.equal(puts[2].p_payload[0].tmin,0);
console.log(JSON.stringify({ok:true,unauthorized:401,stored:puts.map(p=>({kind:p.p_kind,rows:p.p_payload.length}))}));
