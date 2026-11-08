import React,{useEffect,useRef,useState} from 'react';
import {Keyboard,Mic,MicOff,PhoneOff,ArrowUp,X} from 'lucide-react';
import Mascot from './Mascot';
import {createVoiceActionGate} from './voiceActions';
import {api} from './api';
import {voiceResultAction} from './companionActions';
import './companion.css';

function deadline(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})]).finally(()=>clearTimeout(timer))}

export default function Companion({execute,context}){
 const[open,setOpen]=useState(false),[view,setView]=useState('choose'),[messages,setMessages]=useState([]),[input,setInput]=useState(''),[thinking,setThinking]=useState(false),[status,setStatus]=useState('disconnected'),[phase,setPhase]=useState('idle'),[muted,setMuted]=useState(false),[error,setError]=useState('');
 const session=useRef(null),generation=useRef(0),starting=useRef(false),request=useRef(null),mounted=useRef(true),launcher=useRef(),panel=useRef(),textInput=useRef(),scroll=useRef(),latest=useRef({execute,context}),seen=useRef(new Set());
 latest.current={execute,context};
 const live=status==='connected'||status==='connecting',state=thinking?'thinking':live?phase:'idle';
 useEffect(()=>{document.documentElement.dataset.mutaCall=live?'active':'';if(!live)window.top.dispatchEvent(new Event('commutr:idle'));return()=>{delete document.documentElement.dataset.mutaCall}},[live]);
 const append=(role,text,extra={})=>setMessages(m=>[...m,{id:crypto.randomUUID(),role,text,...extra}].slice(-12));
 function resetText(){request.current?.abort();generation.current++;setMessages([]);setInput('');setError('');setThinking(false)}
 function hide(){setOpen(false);if(!live){resetText();setView('choose')}setTimeout(()=>launcher.current?.focus(),0)}
 function reveal(){if(!live){resetText();setView('choose')}setOpen(true)}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;request.current?.abort();session.current?.endSession();session.current=null}},[]);
 useEffect(()=>{if(open){if(view==='text')textInput.current?.focus();else panel.current?.focus()}},[open,view]);
 useEffect(()=>{scroll.current?.scrollIntoView?.({block:'nearest',behavior:'smooth'})},[messages,thinking,open]);
 useEffect(()=>{if(status==='connected')session.current?.sendContextualUpdate(`Current Commutr screen: ${context.page}. Active trip: ${context.activeTrip||'none'}.`);},[context.page,context.activeTrip,status]);
 useEffect(()=>{if(!open)return;function key(e){if(e.key==='Escape'){hide()}}document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)},[open,live]);
 async function act(action){try{const result=await latest.current.execute(action);if(result?.ok&&['plan_trip','navigate'].includes(action.type))setOpen(false);return result}catch(e){const result={ok:false,summary:e.message||'Couldn’t complete that action. Try again.'};return result}}
 async function send(text=input){text=text.trim();if(!text||thinking||live)return;const turn=generation.current;setInput('');setError('');append('user',text);setThinking(true);request.current=new AbortController();
 try{const history=messages.slice(-6).map(m=>({role:m.role==='user'?'user':'agent',text:m.role==='action'?'Commutr app result: '+m.text:m.text}));const result=await api('/companion/chat',{message:text,history,context:latest.current.context},{signal:request.current.signal});if(!mounted.current||turn!==generation.current)return;append('agent',result.reply,{source:result.source});for(const action of (result.actions||[]).slice(0,3)){const outcome=await act(action);if(turn===generation.current&&outcome?.summary)append('action',outcome.summary)}}catch(e){if(turn===generation.current&&e.name!=='AbortError')setError(e.message||'Couldn’t send. Try again.')}finally{if(mounted.current&&turn===generation.current)setThinking(false)}}
 async function end(){generation.current++;starting.current=false;const current=session.current;session.current=null;setStatus('disconnected');setPhase('idle');setMuted(false);setMessages([]);setInput('');setError('');setView('choose');try{await current?.endSession()}catch{/* already disconnected */}}
 async function startVoice(){if(starting.current||session.current)return;starting.current=true;const version=++generation.current;setMessages([]);setInput('');setView('voice');setError('');setStatus('connecting');setPhase('thinking');seen.current.clear();
 try{const credentials=await api('/companion/session',{});if(version!==generation.current)return;
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access needs HTTPS or localhost. You can type instead.');
 await deadline(navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return stream}),20000,'Microphone permission is still waiting. Allow microphone access in your browser, then try again, or type instead.');if(version!==generation.current)return;
 const {Conversation}=await import('@elevenlabs/client');if(version!==generation.current)return;
 const voiceActions=createVoiceActionGate({execute:action=>version===generation.current?act(action):Promise.resolve({ok:false,summary:'The call has ended.'}),getTripId:()=>latest.current.context.activeTripId,getReward:async id=>(await api('/rewards')).rewards.find(r=>r.id===id)});
 const current=await deadline(Conversation.startSession({signedUrl:credentials.signed_url,connectionType:'websocket',dynamicVariables:{demo_user:'1'},
 onConnect:()=>{if(version===generation.current){setStatus('connected');setPhase('listening')}},
 onDisconnect:()=>{if(version===generation.current){session.current=null;setStatus('disconnected');setPhase('idle');setMessages([])}},
 onError:()=>{if(version===generation.current)setError('The call was interrupted. End the call and try again, or switch to typing.')},
 onModeChange:({mode})=>{if(version===generation.current)setPhase(mode==='speaking'?'speaking':'listening')},
 onMessage:message=>{if(version!==generation.current)return;if(message.role==='user'||message.source==='user'){voiceActions.observe(message.message);setPhase('thinking')}},
 onInterruption:()=>{if(version===generation.current)setPhase('listening')},
 onAgentToolRequest:()=>{if(version===generation.current)setPhase('thinking')},
 onAgentToolResponse:event=>{if(version!==generation.current)return;const action=voiceResultAction(event);if(action&&!seen.current.has(event.tool_call_id)){seen.current.add(event.tool_call_id);act(action).catch(()=>setError('Couldn’t update the app. Try asking again.'))}},
 clientTools:{discover_places:params=>api('/companion/discover',{query:params.query}),navigate:params=>act({type:'navigate',page:params.page}),plan_trip:params=>act({...params,type:'plan_trip'}),start_trip:params=>act({type:'start_trip',mode:params.mode}),finish_trip:()=>voiceActions.request({type:'finish_trip'}),redeem_reward:params=>voiceActions.request({type:'redeem_reward',reward_id:params.reward_id}),get_status:async()=>{await latest.current.execute({type:'refresh'});return (await api('/companion/account')).status},get_rewards:async()=>{await act({type:'navigate',page:'Rewards'});return {rewards:(await api('/companion/account')).rewards}},get_clubs:async()=>(await api('/companion/account')).clubs,get_route_safety:params=>act({type:'get_route_safety',destination:params.destination})}
 }).then(current=>{if(version!==generation.current)current.endSession();return current}),20000,'The voice connection timed out. Try again, or type instead.');if(version!==generation.current){await current.endSession();return}session.current=current;setStatus('connected');setPhase('listening');current.sendContextualUpdate(`You are on the ${latest.current.context.page} screen. Help with local outings too. For boredom or somewhere new, use discover_places to find real KW places beyond the presets, suggest one or two and offer a route after the user chooses. Keep replies natural and skip motivational filler. Use navigate to open screens and plan_trip to show routes. You are Muta. Keep replies to one or two short sentences, usually 15–40 words. Starting trips and navigation are direct. Before finishing a trip or redeeming a reward, the browser tool returns voice_confirmation_required with the exact question. Ask that question aloud, wait for a new clear yes, and call the same tool again. A confirm parameter does not bypass this. Do not ask for an on-screen confirmation. Only claim success after the tool result. Ask a brief spoken question only if the requested action is unclear.`);
 }catch(e){if(version===generation.current){generation.current++;starting.current=false;setStatus('disconnected');setPhase('idle');setError(e.name==='NotAllowedError'?'Microphone permission was declined. Allow it in browser settings or type instead.':e.message||'Couldn’t connect the call. Try again.')}}finally{if(version===generation.current)starting.current=false}}
 const label=status==='connecting'?'Connecting…':state==='thinking'?'Thinking…':state==='speaking'?'Speaking…':muted?'Muted':status==='connected'?'Listening…':'';
 return <div className="companion-root">
 {!open&&<button ref={launcher} className={`companion-peek ${live?'on-call':''}`} aria-label={live?'Reopen Muta call':'Open Muta'} aria-expanded={false} onClick={reveal}><span className="peek-character"><Mascot state={state}/></span>{live&&<span className="call-dot"/>}</button>}
 {open&&<>
 <div className="companion-backdrop" aria-hidden="true" onClick={hide}/>
 <section ref={panel} tabIndex={-1} className={`companion-panel companion-${view}`} role="dialog" aria-label="Muta">
 <button className="companion-close" aria-label={live?'Minimize call':'Close Muta'} onClick={hide}><X size={21}/></button>
 <div className="companion-stage"><Mascot state={state}/></div><div className="muta-wordmark" role="img" aria-label="Muta"><svg viewBox="155 0 252 122" aria-hidden="true"><defs><clipPath id="muta-mark-crop"><path d="M165 0H407V122H155V87H165Z"/></clipPath></defs><image href="/mockup-logo.png" width="530" height="122" clipPath="url(#muta-mark-crop)"/></svg><span aria-hidden="true">ta</span></div>
 {view==='choose'?<div className="companion-choices"><button onClick={()=>{setMessages([]);setError('');setView('text')}}><Keyboard size={20}/>Let’s type</button><button onClick={startVoice}><Mic size={20}/>Let’s talk</button></div>:<>
 {view==='text'&&<div className="companion-paper">
 <div className="companion-conversation" role="log" aria-label="Conversation" aria-live="polite">{!messages.length&&<p className="companion-empty">Where do you feel like going?</p>}{messages.map(m=><div className={`companion-message ${m.role}`} key={m.id}><p>{m.text}</p></div>)}{thinking&&<p className="companion-thinking" role="status">Thinking…</p>}<div ref={scroll}/></div>
 <form className="companion-input" onSubmit={e=>{e.preventDefault();send()}}><label className="sr-only" htmlFor="companion-message">Message Muta</label><input ref={textInput} id="companion-message" maxLength={2000} value={input} onChange={e=>setInput(e.target.value)} placeholder="I’m bored. Where should I go?" disabled={thinking}/><button aria-label="Send message" disabled={!input.trim()||thinking}><ArrowUp size={20}/></button></form>
 </div>}
 {view==='voice'&&<><p className="companion-status" role="status">{label}</p><div className="companion-call-controls">{live?<><button disabled={status!=='connected'} aria-label={muted?'Unmute microphone':'Mute microphone'} aria-pressed={muted} onClick={()=>{session.current?.setMicMuted(!muted);setMuted(!muted)}}>{muted?<MicOff size={21}/>:<Mic size={21}/>}</button><button className="end-call" onClick={end}><PhoneOff size={20}/>{status==='connecting'?'Cancel call':'End call'}</button></>:<button onClick={startVoice}><Mic size={20}/>Try again</button>}</div><button className="companion-switch" onClick={async()=>{await end();setView('text')}}>Type instead</button></>}

 </>}
 {error&&<p className="companion-error" role="alert">{error}</p>}
 </section></>}
 </div>;
}
