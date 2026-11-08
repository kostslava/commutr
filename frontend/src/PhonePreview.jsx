import React,{useEffect,useState} from 'react';
const sizes={Small:[320,740],Standard:[390,844],Large:[430,932]};
export default function PhonePreview(){const[scale,setScale]=useState(1),[device,setDevice]=useState('Standard');const[width,height]=sizes[device];
 useEffect(()=>{function fit(){setScale(Math.min(1,(window.innerHeight-82)/(height+16),(window.innerWidth-60)/(width+16)))}fit();window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit)},[width,height]);
 return <div className="preview-stage"><div style={{width:(width+16)*scale,height:(height+16)*scale}}><div className="phone-frame" style={{width:width+16,height:height+16,transform:`scale(${scale})`}}><iframe style={{width,height}} allow="microphone; geolocation" title="Commutr phone preview" src="/?phone=1"/></div></div><label className="preview-caption">Commutr · <select aria-label="Phone preview size" value={device} onChange={e=>setDevice(e.target.value)}>{Object.entries(sizes).map(([name,[w,h]])=><option key={name}>{name}</option>)}</select> · {width} × {height}</label></div>
}
