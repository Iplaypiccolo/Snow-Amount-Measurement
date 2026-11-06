import { handle } from './core.mjs';
const base=Deno.env.get('SUPABASE_URL')??'';
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY')??'';
async function rpc(name:string,body:object){
  const r=await fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!r.ok)return false;return await r.json()===true;
}
const deps={
  now:()=>Date.now(),env:(name:string)=>Deno.env.get(name)??'',sleep:(ms:number)=>new Promise(r=>setTimeout(r,ms)),
  tokenOk:(t:string)=>rpc('collector_token_ok',{t}),
  put:(p_kind:string,p_issued_at:string,p_payload:object[])=>rpc('forecast_midterm_put',{p_kind,p_issued_at,p_payload}),
  async fetchText(url:string){
    // 실제 동작을 확인한 probe-daily-forecast와 같은 요청 설정을 사용한다.
    const r=await fetch(url,{signal:AbortSignal.timeout(25000)});
    const bytes=new Uint8Array(await r.arrayBuffer());
    if(bytes.length>2097152)return {status:r.status,bytes:bytes.length,text:''};
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('euc-kr').decode(bytes);}
    return {status:r.status,bytes:bytes.length,text};
  },
};
Deno.serve((req:Request)=>{
  if(!base||!secret)return new Response('{"ok":false,"error":"server_misconfigured"}',{status:503});
  return handle(req,deps);
});
