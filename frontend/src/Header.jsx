import React,{useLayoutEffect,useRef,useState} from 'react';
import {stepLogoMotion} from './logoMotion';

// Split the original artwork so the same mark travels out of the home wordmark.
const markOutline='M165 0H407V122H155V87H165Z';
const dots='M226.5 99a8 8 0 1 0-16 0a8 8 0 1 0 16 0 M277 99a8 8 0 1 0-16 0a8 8 0 1 0 16 0';
export default function Header({tab,eco,points,navigate}){
 const home=tab==='Home',header=useRef(null),mark=useRef(null),letters=useRef(null),ripple=useRef(null),wave=useRef(null),bounce=useRef(null),[width,setWidth]=useState(390);
 const motion=useRef({position:home?0:1,velocity:0,phase:0,amplitude:0,pulse:{position:0,velocity:0}});
 const previousTab=useRef(tab);
 useLayoutEffect(()=>{
  const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));
  observer.observe(header.current);
  return()=>observer.disconnect();
 },[]);
 const scale=Math.min(width*.78/530,80/122);
 useLayoutEffect(()=>{
  const target=home?0:1,reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(previousTab.current!==tab&&previousTab.current!=='Home'&&!home){
   // A small ripple at the edge; keep the existing wave and any ongoing travel.
   motion.current.pulse.velocity=450;
  }
  previousTab.current=tab;
  let frame,last;
  function tick(now){
   const dt=last===undefined?0:Math.min((now-last)/1000,.05);last=now;
   const state=motion.current;
   Object.assign(state,reduced.matches?{position:target,velocity:0}:stepLogoMotion(state,target,dt));
   state.pulse=reduced.matches?{position:0,velocity:0}:stepLogoMotion(state.pulse,0,dt);
   const travelSettled=Math.abs(state.position-target)<.0005&&Math.abs(state.velocity)<.005;
   if(travelSettled){state.position=target;state.velocity=0;}
   const strength=Math.min(Math.max(Math.abs(state.velocity)*7,state.pulse.position),24);
   state.amplitude+=(strength-state.amplitude)*(1-Math.exp(-18*dt));
   const settled=travelSettled&&Math.abs(state.pulse.position)<.01&&Math.abs(state.pulse.velocity)<.05&&state.amplitude<.01;
   if(settled||reduced.matches){state.pulse={position:0,velocity:0};state.amplitude=0;}
   state.phase+=dt*230;
   const p=state.position,left=(width-530*scale)/2+155*scale,top=20+(80-122*scale)/2;
   mark.current.style.left=`${left+(17-left)*p}px`;
   mark.current.style.top=`${top+(25-top)*p}px`;
   mark.current.style.width=`${252*scale+(110-252*scale)*p}px`;
   letters.current.style.opacity=Math.max(0,1-p*5);
   ripple.current.setAttribute('scale',state.amplitude);
   wave.current.setAttribute('x',155-252-(state.phase%252));
   bounce.current.setAttribute('transform',`translate(0 ${-state.amplitude*.25})`);
   if(!settled&&!reduced.matches)frame=requestAnimationFrame(tick);
  }
  frame=requestAnimationFrame(tick);
  return()=>cancelAnimationFrame(frame);
 },[tab,home,width,scale]);
 const position={'--title-delay':!home&&motion.current.position<.95?'560ms':'0ms','--mark-left':`${(width-530*scale)/2+155*scale}px`,'--mark-top':`${20+(80-122*scale)/2}px`,'--mark-width':`${252*scale}px`};
 return <header ref={header} style={position} className={'mockup-header animated-header '+(home?'header-home':'header-compact')}>
 <a href="#" className="animated-brand" aria-label="Commutr home" onClick={e=>{e.preventDefault();navigate('Home')}}>
  <svg ref={letters} className="brand-full" viewBox="0 0 530 122" aria-hidden="true"><defs><clipPath id="brand-letters"><path d={'M0 0H530V122H0Z '+markOutline} clipRule="evenodd"/></clipPath></defs><image href="/mockup-logo.png" width="530" height="122" clipPath="url(#brand-letters)"/></svg>
  <svg ref={mark} className="brand-mark" viewBox="155 0 252 122" aria-hidden="true">
   <defs><filter id="brand-ripple" x="120" y="-40" width="322" height="202" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feImage ref={wave} href="/logo-ripple.svg" x="-97" y="-40" width="756" height="202" preserveAspectRatio="none" result="wave"/><feDisplacementMap ref={ripple} in="SourceGraphic" in2="wave" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter><clipPath id="brand-mark-body"><path d={markOutline+' '+dots} clipRule="evenodd"/></clipPath><clipPath id="brand-dot-one"><circle cx="218.5" cy="99" r="8"/></clipPath><clipPath id="brand-dot-two"><circle cx="269" cy="99" r="8"/></clipPath></defs>
   <g ref={bounce}><g filter="url(#brand-ripple)"><image href="/mockup-logo.png" width="530" height="122" clipPath="url(#brand-mark-body)"/>
   <g className="brand-dots"><image href="/mockup-logo.png" width="530" height="122" clipPath="url(#brand-dot-one)"/><image href="/mockup-logo.png" width="530" height="122" clipPath="url(#brand-dot-two)"/></g></g></g>
  </svg>
 </a>
 <div className="header-context">{!home&&<h1 key={tab}>{tab==='Explore'?'Map':tab==='Rewards'?'Shop':tab}</h1>}<div className="header-metrics"><button aria-label={`Eco score ${eco} out of 100`} onClick={()=>navigate('Wallet')}><span>{eco??'—'}</span> eco</button><button aria-label={`${points} points. Open wallet`} onClick={()=>navigate('Wallet')}><span>{points??'—'}</span> pts</button></div></div></header>
}
