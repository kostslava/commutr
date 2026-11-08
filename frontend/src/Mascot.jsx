import React,{useEffect,useState} from 'react';
const frames={idle:[0,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],listening:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],thinking:[2,3,4,5,4,3],speaking:[8,9,10,11,12,13,14,15]};
export default function Mascot({state='idle',className=''}){
 const[tick,setTick]=useState(0);
 useEffect(()=>{setTick(0);const timer=setInterval(()=>setTick(n=>n+1),state==='speaking'?150:280);return()=>clearInterval(timer)},[state]);
 const frame=frames[state]?.[tick%frames[state].length]??0,sheet=state==='speaking'||state==='thinking'?'talking':state==='listening'?'listening':'idle';
 return <span className={`mascot-art mascot-${state} ${className}`} aria-hidden="true"><span className="mascot-sprite" style={{backgroundImage:`url(/mascot/${sheet}.png)`,backgroundPosition:`${frame%4*100/3}% ${Math.floor(frame/4)*100/3}%`}}/></span>;
}
