import React,{useEffect,useRef,useState} from 'react';
import {Camera,Check,X} from 'lucide-react';
export default function TripEvidence({tracker}){
 const [photo,setPhoto]=useState(null),[preview,setPreview]=useState(''),[error,setError]=useState('');
 const input=useRef();
 useEffect(()=>{if(!photo){setPreview('');return}const url=URL.createObjectURL(photo);setPreview(url);return()=>URL.revokeObjectURL(url)},[photo]);
 const saved=tracker.trip.evidence_status==='submitted';
 function choose(e){const file=e.target.files[0];e.target.value='';if(!file)return;setError('');if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setError('Choose a JPG, PNG, or WebP photo.');return}if(file.size>5*1024*1024){setError('Choose a photo under 5 MB.');return}setPhoto(file)}
 return <div className="trip-evidence"><input ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Trip evidence photo" hidden onChange={choose}/>
 {photo?<div className="evidence-preview"><img src={preview} alt="Selected trip evidence"/><span>{photo.name}</span><button aria-label="Remove selected photo" onClick={()=>setPhoto(null)}><X size={16}/></button><button disabled={tracker.busy} onClick={async()=>{if(await tracker.uploadEvidence(photo))setPhoto(null)}}>{tracker.busy?'Uploading…':'Upload photo'}</button></div>:<button className="add-evidence" disabled={tracker.busy} onClick={()=>input.current.click()}>{saved?<Check size={16}/>:<Camera size={16}/>} {saved?'Photo saved · replace':'Add trip photo'}</button>}
 {tracker.trip.demo&&<small>Demo trip · use your drawn ticket, bike, or walking photo.</small>}{error&&<p role="alert">{error}</p>}
 </div>;
}
