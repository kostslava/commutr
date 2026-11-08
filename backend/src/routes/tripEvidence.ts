import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { CurrentUserEnv } from '../currentUser.js';
import type { DB } from '../db.js';
import { bad, idParam, notFound } from './http.js';
import { capToDaily, tripPoints } from '../scoring/apply.js';
import { torontoDate, torontoDayRangeUtc } from '../time.js';
import type { Mode } from '../scoring/config.js';

export const demoDistances: Record<string,number> = {'Kitchener City Hall':.4,'Victoria Park, Kitchener':1.1,'Kitchener Market':1.2,'Waterloo Public Library':4.2,'University of Waterloo':6.4,'Kitchener GO station':.9};
const MAX_PHOTO=5*1024*1024;
function imageType(b:Buffer){
 if(b.length>12&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(b.length>12&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if(b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
 return null;
}
export function evidenceRoutes(db:DB){
 const r=new Hono<CurrentUserEnv>();
 r.use('/trips/:id/evidence',bodyLimit({maxSize:MAX_PHOTO+65536,onError:c=>c.json({error:{code:'photo_too_large',message:'Choose a photo under 5 MB.'}},413)}));
 r.post('/trips/:id/evidence',async c=>{
  const id=idParam(c);if(id===null)return notFound(c,'trip',c.req.param('id'));
  const trip=db.prepare('SELECT status FROM trips WHERE id=? AND user_id=?').get(id,c.get('userId')) as {status:string}|undefined;
  if(!trip)return notFound(c,'trip',id);
  if(trip.status!=='active')return c.json({error:{code:'trip_not_active',message:'This trip is already finished.'}},409);
  let form:FormData;try{form=await c.req.formData()}catch{return bad(c,'Choose a photo to upload.')}
  const photo=form.get('photo');
  if(!(photo instanceof File)||!photo.size)return bad(c,'Choose a photo to upload.');
  if(photo.size>MAX_PHOTO)return c.json({error:{code:'photo_too_large',message:'Choose a photo under 5 MB.'}},413);
  const bytes=Buffer.from(await photo.arrayBuffer()),mime=imageType(bytes);
  if(!mime||mime!==photo.type)return bad(c,'Use a JPG, PNG, or WebP photo.');
  // Re-check after reading the body: a concurrent finish must not accept a late photo.
  const saved=db.transaction(()=>{
   const current=db.prepare('SELECT status FROM trips WHERE id=? AND user_id=?').get(id,c.get('userId')) as {status:string}|undefined;
   if(current?.status!=='active')return false;
   db.prepare(`INSERT INTO trip_evidence(trip_id,mime_type,photo) VALUES(?,?,?) ON CONFLICT(trip_id) DO UPDATE SET mime_type=excluded.mime_type,photo=excluded.photo,submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(id,mime,bytes);
   return true;
  })();
  if(!saved)return c.json({error:{code:'trip_not_active',message:'This trip is already finished.'}},409);
  return c.json({trip_id:id,evidence_status:'submitted',message:'Photo saved. GPS checks still apply to real trips.'},201);
 });
 return r;
}

export function finishDemoTrip(db:DB,userId:number,id:number){
 return db.transaction(()=>{
  const trip=db.prepare('SELECT * FROM trips WHERE id=? AND user_id=?').get(id,userId) as {id:number;mode:Mode;status:string;demo:number;demo_distance:number;started_at:string}|undefined;
  if(!trip)return {error:{code:'not_found',message:'Trip not found.'},status:404 as const};
  if(trip.status!=='active')return {error:{code:'trip_not_active',message:'This trip is already finished.'},status:409 as const};
  if(!db.prepare('SELECT trip_id FROM trip_evidence WHERE trip_id=?').get(id))return {error:{code:'evidence_required',message:'Add a photo before finishing the demo trip.'},status:400 as const};
  const ended=new Date().toISOString(),[from,to]=torontoDayRangeUtc(torontoDate(ended));
  const {used}=db.prepare("SELECT COALESCE(SUM(points_awarded),0) AS used FROM trips WHERE user_id=? AND status='finished' AND ended_at>=? AND ended_at<?").get(userId,from,to) as {used:number};
  const raw=tripPoints(trip.demo_distance,trip.mode,1,1),awarded=capToDaily(raw,used);
  db.prepare('UPDATE users SET points=points+? WHERE id=?').run(awarded,userId);
  // A demo never changes real-trip trust, eco score, streaks, or club progress.
  db.prepare("UPDATE trips SET status='finished',ended_at=?,distance_km=?,points_awarded=?,confidence=NULL,flags='[\"demo_evidence\"]' WHERE id=?").run(ended,trip.demo_distance,awarded,id);
  const user=db.prepare('SELECT points,eco_score FROM users WHERE id=?').get(userId);
  return {trip:{id,mode:trip.mode,status:'finished',demo:true,distance_km:trip.demo_distance,points_awarded:awarded,flags:['demo_evidence'],capped:awarded<raw},user,evidence_status:'submitted'};
 })();
}
