// Temporary browser ledger for the photo flow. Server rewards remain server-owned.
export const photoTripsKey='commutr:photo-trips:v1:user:1';
export const photoTripsChanged='commutr:photo-trips-changed';
export const tripDate=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function readPhotoTrips(){
 try{const trips=JSON.parse(localStorage.getItem(photoTripsKey)||'[]');return Array.isArray(trips)?trips.filter(t=>typeof t.id==='string'&&Number.isFinite(t.points_awarded)&&t.points_awarded>=0):[]}catch{return []}
}
export function completePhotoTrip(trip,serverPointsToday=0){
 const trips=readPhotoTrips(),existing=trips.find(t=>t.id===String(trip.id));if(existing)return existing;
 const ended=new Date().toISOString(),day=tripDate(new Date(ended)),used=trips.filter(t=>t.points_date===day).reduce((n,t)=>n+t.points_awarded,0)+Math.max(0,serverPointsToday);
 const rate={walk:10,bike:6,transit:12,scooter:4,car:0}[trip.mode]||0,distance=Math.max(0,Number(trip.distance_km)||0),raw=Math.round(distance*rate),points=Math.min(raw,Math.max(0,200-used));
 const finished={...trip,id:String(trip.id),status:'finished',demo:false,local_demo:true,ended_at:ended,points_date:day,points_awarded:points,capped:points<raw,distance_km:distance};
 localStorage.setItem(photoTripsKey,JSON.stringify([finished,...trips]));window.dispatchEvent(new Event(photoTripsChanged));return finished;
}
export function photoPoints(trips){return trips.reduce((n,t)=>n+t.points_awarded,0)}
