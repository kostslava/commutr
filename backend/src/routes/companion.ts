import {Hono} from 'hono';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {DB} from '../db.js';
import type {CurrentUserEnv} from '../currentUser.js';
import {discoverPlaces} from '../chat/discover.js';
import {runTool} from '../chat/tools.js';
import {listRewards} from '../rewards/redeem.js';
import {companionReply,type HistoryItem} from '../chat/companion.js';
import {takeUserRequest} from '../chat/usage.js';
import {isObj,jsonBody,bad} from './http.js';
import type {Context} from 'hono';
import {COMPANION_PLAN_BUDGET_MS,FALLBACK_RESERVE_MS,GEOCODE_TIMEOUT_MS,inKwArea} from '../planner/config.js';
import {plan,isPlanError} from '../planner/plan.js';
import {parseDestination,resolveDestination,resolveOrigin,PlaceBook,validLatLng} from '../planner/places.js';

export function agentId(){
 if(process.env.ELEVENLABS_AGENT_ID?.trim())return process.env.ELEVENLABS_AGENT_ID.trim();
 const path=fileURLToPath(new URL('../../elevenlabs/state.json',import.meta.url));
 try{return existsSync(path)?String(JSON.parse(readFileSync(path,'utf8')).agent_id||''):''}catch{return ''}
}
/** 429 with the wait in the body (retry_after_sec) and the Retry-After header, like /api/plan. */
function rateLimited(c:Context,retryAfterSec:number,message:string){
 c.header('Retry-After',String(retryAfterSec));
 return c.json({error:{code:'rate_limited',message},retry_after_sec:retryAfterSec},429);
}
/** One deadline for the whole request (look-ups + planner), COMPANION_PLAN_BUDGET_MS from arrival. */
export async function companionPlan(db:DB,userId:number,body:Record<string,unknown>,startedAt=Date.now()){
 const left=()=>startedAt+COMPANION_PLAN_BUDGET_MS-Date.now();
 const lookupMs=()=>Math.max(0,Math.min(GEOCODE_TIMEOUT_MS,left()-FALLBACK_RESERVE_MS));
 const destination=parseDestination(body.destination);if(!destination)return {error:{code:'validation_error',message:'Where would you like to go?'},status:400};
 const origin=await resolveOrigin(db,userId,body,lookupMs());
 if(!origin||typeof origin==='string')return {error:{code:typeof origin==='string'?origin:'no_origin',message:origin==='origin_not_found'?'I couldn’t find that starting place. Try a nearby KW landmark.':'Where are you starting from?'},status:400};
 const found=await resolveDestination(db,userId,destination,new PlaceBook(),lookupMs(),origin.at);
 if(!found.ok)return {error:{code:found.code,message:found.code==='destination_not_found'?'I couldn’t find that place in KW. Try another name.':'Place search is unavailable. Try again shortly.'},status:503};
 const place=found.candidates[0]!;
 // Resolve once, then compute the same origin/destination as the geometry the app draws.
 const result=await plan(db,userId,{destination:{name:place.display_name.slice(0,120),lat:place.at[0],lng:place.at[1]},origin_lat:origin.at[0],origin_lng:origin.at[1]},{startedAt,budgetMs:COMPANION_PLAN_BUDGET_MS});
 if(isPlanError(result))return {error:{code:result.code,message:result.message},status:result.status};
 return {...result,attribution:[...new Set([...result.attribution,...(found.usedSearch||origin.kind==='named'?['Search: © OpenStreetMap contributors (Nominatim)']:[])])],origin:origin.kind,origin_name:origin.name,summary:result.summary.replace(/^(From your current location,|Starting from your current location\.)/i,`From ${origin.name},`),map_origin:{name:origin.name,lat:origin.at[0],lng:origin.at[1]},map_destination:{name:place.display_name,lat:place.at[0],lng:place.at[1]}};
}
export function companionRoutes(db:DB){
 const r=new Hono<CurrentUserEnv>();
 r.get('/companion/account',c=>c.json({status:runTool(db,c.get('userId'),'get_my_status'),clubs:runTool(db,c.get('userId'),'get_clubs'),rewards:listRewards(db,c.get('userId')).map(r=>({reward_id:r.id,title:r.title,merchant:r.merchant.name,points_cost:r.points_cost,min_eco_score:r.min_eco_score,affordable:r.affordable,locked:r.locked,redeemed_today:r.redeemed_today,points_needed:r.points_needed,eco_needed:r.eco_needed}))}));
 r.post('/companion/discover',async c=>{const body=await jsonBody(c);if(!isObj(body)||typeof body.query!=='string'||!body.query.trim()||body.query.length>160)return bad(c,'query must be 1–160 characters');const limit=takeUserRequest('discover',c.get('userId'));if(!limit.ok)return rateLimited(c,limit.retryAfterSec,'Give place search a moment, then try again.');// Optional start for distances: { origin: { lat, lng } } inside KW; otherwise the saved home.
  let origin:{at:[number,number];kind:'given'}|undefined;
  if(body.origin!==undefined){const o=body.origin;if(!isObj(o)||!validLatLng(o.lat,o.lng)||!inKwArea(o.lat as number,o.lng as number))return bad(c,'origin must be { lat, lng } inside Kitchener-Waterloo');origin={at:[o.lat as number,o.lng as number],kind:'given'}}
  return c.json(await discoverPlaces(body.query,{db,userId:c.get('userId'),...(origin?{origin}:{})}));});
 r.post('/companion/chat',async c=>{
  const body=await jsonBody(c);if(!isObj(body)||typeof body.message!=='string'||!body.message.trim()||body.message.length>2000)return bad(c,'message must be 1–2000 characters');
  const limit=takeUserRequest('text',c.get('userId'));if(!limit.ok)return rateLimited(c,limit.retryAfterSec,'A few too many messages. Try again shortly.');
  const history:HistoryItem[]=Array.isArray(body.history)?body.history.slice(-6).filter((m):m is HistoryItem=>isObj(m)&&(m.role==='user'||m.role==='agent')&&typeof m.text==='string'&&m.text.length<=4000).map(m=>({role:m.role,text:m.text})):[];
  const context=isObj(body.context)?{page:['Home','Explore','Wallet','Rewards','Community'].includes(String(body.context.page))?body.context.page:'Home',activeTrip:['walk','bike','scooter','transit','car'].includes(String(body.context.activeTrip))?body.context.activeTrip:null}:{};
  return c.json(await companionReply(db,c.get('userId'),body.message,history,context));
 });
 r.post('/companion/plan',async c=>{
  const startedAt=Date.now();
  const body=await jsonBody(c);if(!isObj(body))return bad(c,'Send a destination and optional origin_name');
  const limit=takeUserRequest('plan',c.get('userId'));if(!limit.ok)return rateLimited(c,limit.retryAfterSec,'Please wait a moment before planning another trip.');
  const result=await companionPlan(db,c.get('userId'),body,startedAt);if('error' in result)return c.json({error:result.error},result.status as 400|503);return c.json(result);
 });
 r.post('/companion/session',async c=>{
  c.header('Cache-Control','no-store');
  const key=process.env.ELEVENLABS_API_KEY,id=agentId();
  if(!key||!id)return c.json({error:{code:'voice_not_configured',message:'Voice isn’t connected yet. You can type instead.'}},503);
  const limit=takeUserRequest('voice',c.get('userId'));if(!limit.ok)return rateLimited(c,limit.retryAfterSec,'Please wait a moment before starting another call.');
  try{
   const res=await fetch('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?'+new URLSearchParams({agent_id:id}),{headers:{'xi-api-key':key},signal:AbortSignal.timeout(10000)});
   if(!res.ok)throw new Error('Voice unavailable');const data=await res.json() as {signed_url?:string};if(!data.signed_url?.startsWith('wss://'))throw new Error('No credential');
   return c.json({signed_url:data.signed_url});
  }catch{return c.json({error:{code:'voice_unavailable',message:'Couldn’t reach the voice agent. Try again, or type instead.'}},503)}
 });
 return r;
}
