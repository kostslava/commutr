import React,{useEffect,useRef} from 'react';
import Mascot from './Mascot';
export default function TripReview({active}){
 const panel=useRef();
 useEffect(()=>{if(active)panel.current?.focus()},[active]);
 if(!active)return null;
 return <div className="modal-backdrop trip-review-backdrop"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Reviewing your trip" className="modal trip-review"><div className="trip-review-character"><Mascot state="thinking"/></div><h2>Reviewing your trip…</h2><p role="status">Working out your points</p><div className="trip-review-dots" aria-hidden="true"><i/><i/><i/></div></section></div>
}
