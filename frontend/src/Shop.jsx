import React,{useState} from 'react';
import {ArrowUpRight,ChevronDown,Search,X} from 'lucide-react';
import {rewards as localRewards} from './rewards';
import MerchantLogo,{brandImages} from './MerchantLogo';
const categoryMap={coffee:'Cafes',restaurant:'Restaurants',bakery:'Cafes',gift_card:'Gift cards'};
export default function Shop({rewards,me,onRedeem,busy}){
 const [query,setQuery]=useState(''),[focused,setFocused]=useState(false),[expanded,setExpanded]=useState(null);
 const cards=[...rewards.map(r=>({...r,name:r.title,place:r.merchant.name,cost:r.points_cost,minEco:r.min_eco_score,category:categoryMap[r.merchant.category]||'Stores'})),...localRewards.filter(r=>brandImages[r.place]).map(r=>({...r,id:'preview-'+r.id,preview:true}))];
 const q=query.trim().toLowerCase();
 const visible=cards.filter(r=>[r.name,r.place,r.category,String(r.cost)].some(value=>value.toLowerCase().includes(q)));
 const choices=[...new Set(cards.flatMap(r=>[r.category,r.place]))].filter(value=>value.toLowerCase().includes(q)).slice(0,6);
 return <>
  <div className="shop-search-wrap"><div className="shop-search"><Search size={19}/><input aria-label="Search rewards" placeholder="Search coffee, gift cards, places…" value={query} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} onKeyDown={e=>{if(e.key==='Escape')setFocused(false);if(e.key==='Enter'){setFocused(false);e.currentTarget.blur()}}} onChange={e=>{setQuery(e.target.value);setFocused(true);setExpanded(null)}}/>{query&&<button aria-label="Clear reward search" onClick={()=>{setQuery('');setFocused(false)}}><X size={18}/></button>}</div>
  {focused&&choices.length>0&&<div className="shop-suggestions" aria-label="Reward search suggestions">{choices.map(value=><button key={value} onMouseDown={e=>e.preventDefault()} onClick={()=>{setQuery(value);setFocused(false);setExpanded(null)}}>{value}<ArrowUpRight size={15}/></button>)}</div>}</div>
  <div className="shop-grid compact-shop">{visible.map((r,i)=>{
   const open=expanded===r.id;
   const label=r.preview?'Visit place':r.redeemed_today?'Saved for today':r.locked?`${r.minEco} eco needed`:!r.affordable?`${r.points_needed} more pts`:`${r.cost} pts · Get it`;
   return <article className={'shop-card'+(open?' expanded':'')} key={r.id}>
    <button className="reward-summary" aria-expanded={open} aria-controls={'offer-'+r.id} onClick={()=>setExpanded(open?null:r.id)}>
     <span className={'shop-art '+(r.color||['peach','lime','mint'][i%3])+' '+(r.place==='Seven Shores'?'brand-dark':'')}><MerchantLogo key={r.place} place={r.place}/></span>
     <span className="reward-summary-copy"><strong>{r.name}</strong><span>{r.place}</span><small>{r.preview?'Local preview':`${r.cost.toLocaleString()} pts · Demo reward`}</small></span><ChevronDown size={18}/>
    </button>
    {open&&<div className="offer-details" id={'offer-'+r.id}><p>{r.preview?`Explore ${r.name.toLowerCase()} at ${r.place}; this offer is a preview.`:`Exchange ${r.cost.toLocaleString()} points for ${r.name.toLowerCase()} at ${r.place}.`}</p><button className="primary" disabled={busy===r.id||(!r.preview&&(r.locked||!r.affordable||r.redeemed_today))} onClick={()=>onRedeem(r)}>{busy===r.id?'Saving…':label}<ArrowUpRight size={18}/></button></div>}
   </article>;
  })}{!visible.length&&<div className="empty"><h3>No matches.</h3><p>Try coffee, gift cards, or a place name.</p></div>}</div>
 </>;
}
