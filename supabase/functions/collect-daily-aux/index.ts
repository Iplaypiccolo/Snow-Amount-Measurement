import {handle} from './core.mjs';
const base=Deno.env.get('SUPABASE_URL')??'';
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY')??'';
async function rpc(name:string,body:object,timeout=20000){
  const response=await fetch(base+'/rest/v1/rpc/'+name,{
    method:'POST',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(timeout),
  });
  if(!response.ok)throw new Error('db');const text=await response.text();return text?JSON.parse(text):null;
}
const deps={
  now:()=>Date.now(),sleep:(ms:number)=>new Promise(r=>setTimeout(r,ms)),env:(name:string)=>Deno.env.get(name)??'',
  tokenOk:async(t:string)=>await rpc('collector_token_ok',{t})===true,
  plan:(sky:boolean)=>rpc('forecast_daily_aux_plan',{p_sky:sky}),
  put:async(p_tmfc:string,p_var:string,p_tmef:string,p_vals:(number|null)[]|null,p_empty:boolean)=>
    await rpc('forecast_daily_aux_put',{p_tmfc,p_var,p_tmef,p_vals,p_empty})===true,
  usage:async(p_day:string,p_calls:number,p_bytes:number,p_retries:number)=>{
    await rpc('forecast_usage',{p_day,p_vsrt:false,p_calls,p_bytes,p_retries},10000);return true;
  },
  async fetchText(url:string){
    const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
    const bytes=new Uint8Array(await response.arrayBuffer());
    return{status:response.status,bytes:bytes.length,text:bytes.length<=2097152?new TextDecoder().decode(bytes):''};
  },
};
Deno.serve((request:Request)=>{
  if(!base||!secret)return new Response('{"ok":false,"error":"server_misconfigured"}',{status:503});
  return handle(request,deps);
});
