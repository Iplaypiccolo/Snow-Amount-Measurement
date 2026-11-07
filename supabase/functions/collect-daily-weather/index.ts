import{handle}from './core.mjs';
const base=Deno.env.get('SUPABASE_URL')??'';
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY')??'';
async function rpc(name:string,body:object){
  const r=await fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('rpc_failed');const text=await r.text();return text?JSON.parse(text):null;
}
const deps={now:()=>Date.now(),env:(name:string)=>Deno.env.get(name)??'',sleep:(ms:number)=>new Promise(r=>setTimeout(r,ms)),
  tokenOk:(t:string)=>rpc('collector_token_ok',{t}),plan:()=>rpc('forecast_daily_weather_plan',{}),
  put:(p_slot:string,p_issued_at:string,p_payload:object[])=>rpc('forecast_daily_weather_put',{p_slot,p_issued_at,p_payload}),
  async usage(p_day:string,p_calls:number,p_bytes:number,p_retries:number){await rpc('forecast_usage',{p_day,p_calls,p_bytes,p_retries,p_vsrt:false});return true;},
  async fetchText(url:string){
    const r=await fetch(url,{signal:AbortSignal.timeout(20000)});
    const bytes=new Uint8Array(await r.arrayBuffer());
    if(bytes.length>2097152)return{status:r.status,bytes:bytes.length,text:''};
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('euc-kr').decode(bytes);}
    return{status:r.status,bytes:bytes.length,text};
  },
};
Deno.serve((req:Request)=>{
  if(!base||!secret)return new Response('{"ok":false,"error":"server_misconfigured"}',{status:503});
  return handle(req,deps);
});
