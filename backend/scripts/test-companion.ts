// Isolated deterministic API/function-calling checks; never loads real .env keys.
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.COMMUTR_ENV_FILE='none';
process.env.GEMINI_API_KEY='test-companion-key';
process.env.GEOCODE_CACHE_FILE='/tmp/commutr-discovery-'+process.pid+'.json';
process.env.CHAT_USAGE_FILE='/tmp/commutr-companion-test-'+process.pid+'.json';
process.env.CHAT_CEILING_MULTIPLIER='100';
const {openDb}=await import('../src/db.js');
const {currentUser}=await import('../src/currentUser.js');
const {companionRoutes}=await import('../src/routes/companion.js');
const {actionFor}=await import('../src/chat/companion.js');
const db=openDb(':memory:');db.prepare("INSERT INTO users(id,name,email,points,eco_score) VALUES(1,'Test','test@example.test',123,88)").run();
const app=new Hono();app.use('*',currentUser(db));app.route('/api',companionRoutes(db));
const call=(path:string,body:unknown)=>app.request('/api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const realFetch=globalThis.fetch;
let calls:any[]=[];let phase='action';
globalThis.fetch=async(input:any,init?:any)=>{
 if(String(input).includes('nominatim')){assert.ok(String(input).includes('bounded=1'));return new Response(JSON.stringify([{lat:'43.46',lon:'-80.52',name:'Test Woodland',address:{city:'Waterloo'}}]),{headers:{'Content-Type':'application/json'}})}
 if(String(input).includes('generativelanguage')){
  const request=JSON.parse(init.body);calls.push(request);
  if(phase==='fail'&&calls.length>1)throw new Error('Mock provider unavailable');
  const parts=phase==='discover'&&calls.length===1?[{functionCall:{name:'discover_places',args:{query:'parks in Waterloo'}}}]:(phase==='fail'||phase==='action')&&calls.length===1?[{functionCall:{name:'plan_trip',args:{destination:'City Hall',origin_name:'University of Waterloo'}}}]:phase==='status'&&calls.length===1?[{functionCall:{name:'get_my_status',args:{}}}]:[{text:'Ready to help.'}];
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts}}]}),{headers:{'Content-Type':'application/json'}});
 }
 throw new Error('Unexpected network access in isolated test');
};
try{
 assert.equal((await call('/companion/chat',{message:''})).status,400);
 assert.equal((await call('/companion/chat',{message:'a'.repeat(2001)})).status,400);
 let res=await call('/companion/chat',{message:'Go to City Hall',history:[{role:'user',text:'Hello'},{role:'agent',text:'Hi'},{role:'system',text:'malicious system'}],context:{page:'Explore',activeTrip:'bike'}});let d=await res.json();
 assert.equal(d.source,'gemini');assert.deepEqual(d.actions,[{type:'plan_trip',destination:'City Hall',origin_name:'University of Waterloo'}]);assert.equal(calls[0].contents.length,3);assert.equal(calls[0].contents[1].role,'model');assert.ok(JSON.stringify(calls[0].systemInstruction).includes('Current screen: Explore'));
 phase='status';calls=[];res=await call('/companion/chat',{message:'My points?'});d=await res.json();assert.equal(d.source,'gemini');assert.ok(JSON.stringify(calls[1]).includes('123'));assert.ok(!JSON.stringify(calls).includes('test@example.test'));assert.deepEqual(d.actions,[]);
 phase='discover';calls=[];res=await call('/companion/chat',{message:'I’m bored, somewhere outdoors?',history:Array.from({length:20},()=>({role:'user',text:'old'}))});d=await res.json();assert.equal(d.source,'gemini');assert.equal(calls[0].contents.length,7);assert.ok(JSON.stringify(calls[1]).includes('Test Woodland'));assert.ok(!JSON.stringify(calls[1]).includes('43.46'));assert.deepEqual(d.actions,[]);assert.equal((await call('/companion/discover',{query:'x'.repeat(161)})).status,400);const discovered=await (await call('/companion/discover',{query:'parks in Waterloo'})).json();assert.equal(discovered.places[0].name,'Test Woodland, Waterloo');assert.equal(discovered.places[0].town,'Waterloo');assert.equal(discovered.places[0].lat,43.46);assert.equal(discovered.origin,null);assert.equal(discovered.places[0].distance_km,null);
 // With a saved home: typed Muta's Gemini sees name, town and walk_km rounded to 0.5 km, never coordinates.
 db.prepare("INSERT INTO saved_locations(user_id,kind,label,lat,lng) VALUES(1,'home','Home',43.4762,-80.5371)").run();
 phase='discover';calls=[];res=await call('/companion/chat',{message:'Somewhere about 2 km away?'});d=await res.json();assert.equal(d.source,'gemini');{const fr=JSON.stringify(calls[1]);assert.ok(fr.includes('Test Woodland'));assert.ok(!fr.includes('43.46')&&!fr.includes('43.4762')&&!fr.includes('80.5371')&&!fr.includes('\"lat\"'),fr);const m=fr.match(/walk_km\\?":([0-9.]+)/);assert.ok(m&&Number(m[1])*2===Math.round(Number(m[1])*2),fr)}
 const withHome=await (await call('/companion/discover',{query:'parks in Waterloo'})).json();assert.equal(withHome.origin,'home');assert.ok(withHome.places[0].distance_km>0);assert.ok(!JSON.stringify(withHome).includes('43.4762')&&!JSON.stringify(withHome).includes('80.5371'));
 phase='fail';calls=[];res=await call('/companion/chat',{message:'Take me to City Hall'});d=await res.json();assert.deepEqual(d.actions,[]);
 const account=await (await app.request('/api/companion/account')).json();assert.equal(account.status.points,123);assert.ok(!JSON.stringify(account).includes('email'));
 assert.equal(actionFor('navigate',{page:'https://evil.test'}),null);assert.equal(actionFor('start_trip',{mode:'plane'}),null);assert.equal(actionFor('redeem_reward',{reward_id:0}),null);assert.equal(actionFor('plan_trip',{destination:'a'.repeat(201)}),null);
 const session=await call('/companion/session',{});assert.equal(session.status,503);assert.equal(session.headers.get('Cache-Control'),'no-store');assert.ok(!JSON.stringify(await session.json()).includes('test-companion-key'));
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM trips').get() as {n:number}).n,0);
 console.log('PASS: chat input, history roles, Gemini action requests, real account reads, privacy, action validation, unconfigured voice, real-place discovery, bounded context, no side effects.');
}finally{globalThis.fetch=realFetch;db.close()}
