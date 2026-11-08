import {Type,type FunctionDeclaration} from '@google/genai';
import type {DB} from '../db.js';
import {haversineKm,type LatLng} from '../geo.js';
import {geocode,rememberPlaces,type Box,type GeoResult} from '../planner/geocode.js';
import * as P from '../planner/config.js';
import {parseDistanceQuery} from './distance.js';
export const DISCOVER_TOOL:FunctionDeclaration={name:'discover_places',description:'Find real places beyond the preset destinations in Kitchener-Waterloo. Use for boredom, date ideas, somewhere new, food, walks, parks, museums or cafes. Search a category and town, or verify a named place. Suggest only returned places; never invent hours, prices, events or availability.',parameters:{type:Type.OBJECT,properties:{query:{type:Type.STRING,description:'Public place name or category with a KW town, e.g. parks in Waterloo, cafes in Kitchener, museums in Kitchener.'}},required:['query']}};

/** Nominatim is asked for this many (one request), and at most RETURN_MAX come back, best first. */
export const DISCOVER_SEARCH_LIMIT=10;
export const DISCOVER_RETURN_MAX=5;
/** "Close to" a requested distance: within this many km, or this share of it, whichever is larger. */
export const TARGET_TOLERANCE_KM=0.5;
export const TARGET_TOLERANCE_SHARE=0.3;
/** Smallest and largest distance a request is read as (km along the route). */
export const MIN_TARGET_KM=0.3;
const WALK_KMH=5,BIKE_KMH=15;
/** Places named in the spoken summary (the rest are in `places`). */
const SUMMARY_PLACES=3;

const CAVEAT='Opening hours, prices and events have not been checked.';
const r1=(x:number)=>Math.round(x*10)/10;
const r5=(x:number)=>Math.round(x*1e5)/1e5;

export type DiscoverOptions={
 /** Where distances are measured from. undefined: the user's saved home (needs db and userId). null: none. */
 origin?:{at:LatLng;kind:'home'|'given'}|null;
 db?:DB;userId?:number;
 /** Typed Muta's Gemini: no coordinates, distances rounded to 0.5 km (see docs/api.md). */
 forGemini?:boolean;
};

/** The user's saved home, as a starting point for distances (never returned to the caller). */
export function homeOrigin(db:DB,userId:number):{at:LatLng;kind:'home'}|null{
 const home=db.prepare("SELECT lat, lng FROM saved_locations WHERE user_id = ? AND kind = 'home'").get(userId) as {lat:number;lng:number}|undefined;
 return home?{at:[home.lat,home.lng],kind:'home'}:null;
}

/** A box around the start, half-width `halfKm`, rounded outward to 0.01° and kept inside the KW box. */
export function boxAround(at:LatLng,halfKm:number):Box{
 const dLat=halfKm/111,dLng=halfKm/(111*Math.cos(at[0]*Math.PI/180)),k=P.KW_VIEWBOX;
 const box={west:Math.floor((at[1]-dLng)*100)/100,east:Math.ceil((at[1]+dLng)*100)/100,south:Math.floor((at[0]-dLat)*100)/100,north:Math.ceil((at[0]+dLat)*100)/100};
 const cut={west:Math.max(box.west,k.west),east:Math.min(box.east,k.east),south:Math.max(box.south,k.south),north:Math.min(box.north,k.north)};
 return cut.west<cut.east&&cut.south<cut.north?cut:{...k};
}

type Place={name:string;town:string|null;lat:number;lng:number;distance_km:number|null;walk_km:number|null;walk_minutes:number|null;walkable:boolean|null;route_km:number|null};

export async function discoverPlaces(query:unknown,opts:DiscoverOptions={}){
 if(typeof query!=='string'||!query.trim()||query.length>160)return {ok:false,summary:'What kind of place are you in the mood for?'};
 const origin=opts.origin!==undefined?opts.origin:opts.db&&opts.userId!==undefined?homeOrigin(opts.db,opts.userId):null;
 const want=parseDistanceQuery(query);
 const notes:string[]=[];
 let target=want.km;
 if(target!==null){
  if(target>P.BIKE_MAX_KM){notes.push(`I searched up to ${P.BIKE_MAX_KM} km, the longest trip the app plans by bike.`);target=P.BIKE_MAX_KM}
  if(target<MIN_TARGET_KM)target=MIN_TARGET_KM;
  if(want.mode==='walk'&&target>P.WALK_MAX_KM)notes.push(`The app plans walks up to ${P.WALK_MAX_KM} km, so for about ${target} km a bike ride may suit better.`);
 }
 const detour=want.mode==='bike'?P.DETOUR.bike:P.DETOUR.walk;
 // With a distance and a start: search a box around the start, so results land near that distance.
 const box=target!==null&&origin?boxAround(origin.at,Math.max(1.5,(target/detour)*1.5)):undefined;
 const searchText=target!==null?want.search:query.trim();
 const found=await geocode(searchText,5000,{limit:DISCOVER_SEARCH_LIMIT,...(box?{box}:{})});
 if(!found.ok)return {ok:false,summary:'Place search is unavailable right now. Ask for a different kind of outing or try again shortly.'};

 let places:Place[]=found.results.map(p=>{
  const d=origin?haversineKm(origin.at,[p.lat,p.lng]):null;
  const walk=d===null?null:d*P.DETOUR.walk;
  return {name:p.name,town:p.town??null,lat:r5(p.lat),lng:r5(p.lng),distance_km:d===null?null:r1(d),walk_km:walk===null?null:r1(walk),walk_minutes:walk===null?null:Math.round(walk/WALK_KMH*60),walkable:walk===null?null:walk<=P.WALK_MAX_KM,route_km:d===null?null:d*detour};
 });
 let close=0;
 if(origin){
  if(target!==null){
   const t=target,tol=Math.max(TARGET_TOLERANCE_KM,TARGET_TOLERANCE_SHARE*t);
   const fits=(p:Place)=>want.atMost?p.route_km!<=t:Math.abs(p.route_km!-t)<=tol;
   const gap=(p:Place)=>want.atMost?(p.route_km!<=t?t-p.route_km!:1000+p.route_km!-t):Math.abs(p.route_km!-t);
   places.sort((a,b)=>Number(fits(b))-Number(fits(a))||gap(a)-gap(b));
   close=places.filter(fits).length;
  }else places.sort((a,b)=>a.route_km!-b.route_km!);
 }
 places=places.slice(0,DISCOVER_RETURN_MAX);
 rememberPlaces(places.map(p=>({name:p.name,lat:p.lat,lng:p.lng,town:p.town})) as GeoResult[]);

 const summary=summarise(places,{origin,target,mode:want.mode,atMost:want.atMost,close,notes,round:opts.forGemini?(x:number)=>Math.max(0.5,Math.round(x*2)/2):r1});
 const base={ok:true,origin:origin?.kind??null,target_km:target,summary,attribution:'© OpenStreetMap contributors (Nominatim)'};
 if(opts.forGemini)return {...base,places:places.map(p=>({name:p.name,town:p.town,walk_km:p.walk_km===null?null:Math.max(0.5,Math.round(p.walk_km*2)/2)}))};
 return {...base,places:places.map(({route_km:_r,...p})=>p)};
}

function summarise(places:Place[],o:{origin:{kind:'home'|'given'}|null;target:number|null;mode:'walk'|'bike';atMost:boolean;close:number;notes:string[];round:(x:number)=>number}){
 const pre=o.notes.length?o.notes.join(' ')+' ':'';
 if(!places.length)return pre+(o.target!==null?`No matching places came up within reach of about ${o.target} km. Try another kind of place or a landmark name.`:'No matching places found. Try a nearby town, a more specific category or a landmark name.');
 if(!o.origin)return pre+'These are mapped places in KW. Suggest one or two that suit the request, then offer to plan a route. '+CAVEAT;
 const from=o.origin.kind==='home'?'your saved home':'your current location';
 const how=(p:Place)=>o.mode==='bike'?`about ${o.round(p.route_km!)} km by bike, ${Math.round(p.route_km!/BIKE_KMH*60)} min`:`about ${o.round(p.walk_km!)} km walk, ${Math.max(1,p.walk_minutes!)} min`;
 const list=(ps:Place[])=>ps.map(p=>`${p.name.split(', ')[0]} (${how(p)})`).join(', ');
 const top=places.slice(0,SUMMARY_PLACES);
 const tail=' Suggest one or two, then offer to plan a route. '+CAVEAT;
 if(o.target===null)return pre+`Nearest first from ${from}: ${list(top)}.`+tail;
 const ask=o.atMost?`under ${o.target} km`:`about ${o.target} km`;
 if(o.close>0)return pre+`Closest to ${ask} ${o.mode==='bike'?'by bike':'on foot'} from ${from}: ${list(places.slice(0,Math.min(o.close,SUMMARY_PLACES)))}.`+tail;
 const best=places[0]!;
 return pre+`Nothing came up ${o.atMost?ask:`close to ${o.target} km`}. The closest match is ${best.name.split(', ')[0]} (${how(best)} from ${from}). Say it isn't close to what they asked for, and offer it or a different kind of place.`+' '+CAVEAT;
}
