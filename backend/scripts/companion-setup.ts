// Reuse the existing mascot; attach browser tools so calls survive navigation and
// GPS goes through the same tracker as the rest of the app. No public tunnel needed.
import '../src/env.js';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MUTA_VOICE_PROMPT} from '../src/chat/muta.js';
import {agentId} from '../src/routes/companion.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const key=process.env.ELEVENLABS_API_KEY;
if(!key)throw new Error('Set ELEVENLABS_API_KEY in backend/.env');
async function request(path:string,body?:unknown){const r=await fetch('https://api.elevenlabs.io'+path,{method:body?'POST':'GET',headers:{'xi-api-key':key!,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`ElevenLabs HTTP ${r.status}`);return r.json() as Promise<any>}
let id=agentId();
if(!id){const list=await request('/v1/convai/agents');const matches=list.agents.filter((a:any)=>['Muta','Commutr Mascot'].includes(a.name));if(matches.length!==1)throw new Error('Set ELEVENLABS_AGENT_ID to the existing mascot agent ID');id=matches[0].agent_id;}
const current=await request(`/v1/convai/agents/${id}`);
mkdirSync(root+'data',{recursive:true});
const backup=root+'data/companion-agent-backup.json';if(!existsSync(backup))writeFileSync(backup,JSON.stringify(current,null,2));
const cfg=JSON.parse(readFileSync(root+'elevenlabs/agent.json','utf8'));
const params=(properties:Record<string,unknown>={},required:string[]=[])=>({type:'object',properties,required});
const toolDefs=cfg.tools.map((t:any)=>({name:t.name,description:t.description,parameters:t.body||params()}));
toolDefs.push({name:'navigate',description:'Open a Commutr screen at the user’s request. Explore is the map, Wallet has points and eco benefits, Rewards is the demo shop, Community has clubs.',parameters:params({page:{type:'string',enum:['Home','Explore','Wallet','Rewards','Community'],description:'Commutr screen to open'}},['page'])});
toolDefs.push({name:'get_clubs',description:'Get the current user’s club memberships and weekly progress.',parameters:params()});
toolDefs.push({name:'discover_places',description:'Find real places beyond the preset destinations for boredom, dates, food, parks, cafes, museums or somewhere new in KW. Search a category and town or verify a named place. Suggest only returned places. Do not invent hours, prices or events.',parameters:params({query:{type:'string',description:'Public place name or category with KW town, e.g. parks in Waterloo or cafes in Kitchener.'}},['query'])});
for(const t of toolDefs){
 if(t.name==='plan_trip')t.parameters.properties.mode={type:'string',enum:['walk','bike','transit'],description:'Preferred mode, only if requested by the user.'};
 if(t.name==='redeem_reward'){t.description='Request redeeming a demo reward. Get the reward_id from get_rewards first. Execute only for an explicit redemption request; verify the actual ID and eligibility. No extra confirmation card. Only claim success if the result says ok.';delete t.parameters.properties.confirm;}
 if(t.name==='finish_trip'){t.description='Finish the active trip. Execute when the user asks to finish. Upload pending GPS before scoring. No extra confirmation card. Wait for the result.';delete t.parameters.properties.confirm;}
 if(t.name==='start_trip')t.description='Start foreground GPS tracking in the app. Ask for travel mode if unclear. Execute directly for an explicit request; location permission may be needed; the result says if recording actually started.';
}
const ids:string[]=[];
const statePath=root+'data/companion-tools.json';const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{};
for(const t of toolDefs){
 const tool_config={type:'client',name:t.name,description:t.description,parameters:t.parameters,expects_response:true,response_timeout_secs:120};
 let toolId=state[t.name];
 if(toolId){const r=await fetch(`https://api.elevenlabs.io/v1/convai/tools/${toolId}`,{method:'PATCH',headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({tool_config})});if(!r.ok)throw new Error(`Update ${t.name}: HTTP ${r.status}`)}
 else{toolId=(await request('/v1/convai/tools',{tool_config})).id;state[t.name]=toolId;writeFileSync(statePath,JSON.stringify(state,null,2));}
 ids.push(toolId);console.log(`${t.name}: browser tool configured`);
}
const prompt=MUTA_VOICE_PROMPT;
const body={name:'Muta',conversation_config:{agent:{first_message:'Hey, I’m Muta. What’s the plan?',prompt:{prompt,tool_ids:ids}},conversation:{client_events:['audio','interruption','user_transcript','agent_response','agent_response_correction','vad_score','agent_tool_request','agent_tool_response']},},platform_settings:{auth:{enable_auth:true,allowlist:[]}}};
const r=await fetch(`https://api.elevenlabs.io/v1/convai/agents/${id}`,{method:'PATCH',headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(`Agent update HTTP ${r.status}`);
const stateFile=root+'elevenlabs/state.json';const oldState=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};writeFileSync(stateFile,JSON.stringify({...oldState,agent_id:id},null,2)+'\n');
const verified=await request(`/v1/convai/agents/${id}`);
if(!verified.platform_settings?.auth?.enable_auth||!ids.every(tool=>verified.conversation_config.agent.prompt.tool_ids.includes(tool)))throw new Error('Agent verification failed');
console.log('Existing mascot updated and verified: private signed sessions, ten browser tools. Original configuration backed up in backend/data.');
