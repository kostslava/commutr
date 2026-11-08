const base=import.meta.env.VITE_API_URL||'';
export const backendConfigured=true;
export async function api(path,body,options={}){
 const response=await fetch(base.replace(/\/$/,'')+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Demo-User':'1'},body:body?JSON.stringify(body):undefined,signal:options.signal||AbortSignal.timeout(30000)});
 const data=await response.json();if(!response.ok){const e=new Error(data.error?.message||'Request failed');e.code=data.error?.code;e.status=response.status;e.data=data;throw e;}return data;
}
