import {useEffect,useRef,useState} from 'react';import {api} from './api';import {completePhotoTrip,readPhotoTrips,samePhotoTrip} from './photoTrips';import {places} from './demoTransit';
export default function useTripTracker(refresh,account={}){const[trip,setTrip]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[samples,setSamples]=useState(0),[recording,setRecording]=useState(false),[waitingForLocation,setWaitingForLocation]=useState(false);const watch=useRef(null),queue=useRef(Promise.resolve()),pending=useRef([]),idRef=useRef(null),starting=useRef(false);
 function add(p){setWaitingForLocation(false);const point={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:new Date(p.timestamp).toISOString()};pending.current.push(point);flush()}
 function flush(){if(!pending.current.length||!idRef.current)return;const batch=pending.current.splice(0,500),id=idRef.current;queue.current=queue.current.then(async()=>{try{const result=await api(`/trips/${id}/points`,{points:batch});setSamples(n=>n+result.accepted);setError('')}catch(e){pending.current.unshift(...batch);setError('GPS upload paused. Your points are kept for retry.')}});}
 useEffect(()=>{api('/trips').then(d=>{const active=d.trips.find(t=>t.status==='active'&&!(t.demo&&sessionStorage.getItem(`commutr:finished-demo:${t.id}`))&&!readPhotoTrips().some(saved=>samePhotoTrip(saved,t)));if(active){setTrip(active);idRef.current=active.id}}).catch(()=>{});return()=>{if(watch.current!==null)navigator.geolocation.clearWatch(watch.current)}},[]);
 async function start(mode,options={}){
  if(starting.current||watch.current!==null)return;
  starting.current=true;setBusy(true);setError('');
  try{
   if(trip?.demo||options.demo){
    // Rehearsal trips and their photos stay in the browser; no server trip is needed.
    const active=trip||{id:`demo-${crypto.randomUUID()}`,mode:mode.toLowerCase(),status:'active',demo:true,local_demo:true,demo_destination:options.destination,distance_km:options.distance_km||places.find(p=>p.name===options.destination)?.km||0,evidence_status:'missing'};
    setTrip(active);idRef.current=active.id;setSamples(0);return active;
   }
   if(!navigator.geolocation)throw new Error('Location is unavailable in this browser.');
   // One watch owns the permission request and ongoing fixes. Requesting a
   // one-shot fix as well can show two prompts in embedded browsers.
   const permission=await navigator.permissions?.query({name:'geolocation'}).catch(()=>null);
   if(permission?.state==='denied')throw new Error('Location is blocked. Enable it in your browser settings, then resume.');
   let active=trip;
   if(!active){active=await api('/trips',{mode:mode.toLowerCase()});setTrip(active);idRef.current=active.id;setSamples(0)}
   setWaitingForLocation(true);
   setRecording(true);
   watch.current=navigator.geolocation.watchPosition(add,e=>{
    if(e.code===1){navigator.geolocation.clearWatch(watch.current);watch.current=null;setRecording(false);setWaitingForLocation(false);setError('Allow location to record your trip.')}
    else{setWaitingForLocation(true);setError('')}
   },{enableHighAccuracy:false,maximumAge:30000,timeout:20000});
   return active;
  }catch(e){setError(e.code===1?'Allow location to record your trip.':e.message)}
  finally{starting.current=false;setBusy(false)}
 }
 async function finish(){if(!trip||busy)return;setBusy(true);setError('');if(watch.current!==null){navigator.geolocation.clearWatch(watch.current);watch.current=null}setRecording(false);setWaitingForLocation(false);try{if(trip.demo||trip.evidence_local){if(trip.evidence_status!=='submitted')throw new Error('Add a photo before finishing.');const distance=trip.photo_distance_km||trip.distance_km||places.find(p=>p.name===trip.demo_destination)?.km||0;if(distance<=0)throw new Error('Choose a destination on the map so we can calculate your points.');const result={trip:completePhotoTrip({...trip,distance_km:distance},account?.points_today||0)};sessionStorage.setItem(`commutr:finished-demo:${trip.id}`,'1');setTrip(null);idRef.current=null;setSamples(0);return result}await queue.current;flush();await queue.current;if(pending.current.length)throw new Error('Reconnect and retry so your recorded points can upload.');const result=await api(`/trips/${trip.id}/finish`,{});setTrip(null);idRef.current=null;setSamples(0);await refresh();return result}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function uploadEvidence(photo,options={}){if(!trip||busy)return;setBusy(true);setError('');try{if(trip.demo||options.demo){await new Promise(resolve=>setTimeout(resolve,1400));const result={evidence_status:'submitted',evidence_local:true,photo_distance_km:options.distance_km||trip.distance_km||0};setTrip(t=>t?.id===trip.id?{...t,...result}:t);return result}const form=new FormData();form.append('photo',photo);const result=await api(`/trips/${trip.id}/evidence`,form);setTrip(t=>({...t,evidence_status:result.evidence_status}));return result}catch(e){setError(e.message)}finally{setBusy(false)}}
 return {trip,error,busy,samples,recording,waitingForLocation,start,finish,uploadEvidence};}
