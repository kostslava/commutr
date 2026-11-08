// Only the outer page owns updates. Replacing it also replaces the phone iframe;
// otherwise an old iframe can keep obsolete tool handlers alive after an update.
export function startAppUpdates(host,register){
 if(host.top!==host)return;
 let pending=false;
 function isBusy(){
  const documents=[host.document,host.document.querySelector('iframe[title="Commutr phone preview"]')?.contentDocument];
  return documents.some(doc=>doc&&(doc.documentElement.dataset.mutaCall==='active'||doc.documentElement.dataset.tripRecording==='active'));
 }
 function reloadWhenIdle(){if(!pending||isBusy())return;pending=false;host.location.reload()}
 host.addEventListener('commutr:idle',reloadWhenIdle);
 register({immediate:true,onNeedReload(){pending=true;reloadWhenIdle()},onRegisteredSW(_url,registration){
  if(!registration)return;
  const check=()=>registration.update().catch(()=>{});
  host.addEventListener('focus',check);
  host.setInterval(check,60000);
 }});
}
