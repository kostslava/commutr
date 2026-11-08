import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openDb} from '../src/db.js';
import {currentUser} from '../src/currentUser.js';
import {tripRoutes} from '../src/routes/trips.js';
import type {CurrentUserEnv} from '../src/currentUser.js';
const db=openDb(':memory:');
for(const id of [1,2])db.prepare('INSERT INTO users(id,name,email,points) VALUES(?,?,?,?)').run(id,'Test','test'+id+'@example.test',100);
const app=new Hono<CurrentUserEnv>();app.use('*',currentUser(db));app.route('/api',tripRoutes(db));
async function post(path:string,body:unknown,user=1){return app.request('/api'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-User':String(user)},body:JSON.stringify(body)})}
function form(valid=true){const f=new FormData();const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');f.append('photo',new Blob([valid?png:Buffer.from('not an image')],{type:'image/png'}),'ticket.png');return f}
async function upload(id:number,valid=true,user=1){return app.request(`/api/trips/${id}/evidence`,{method:'POST',headers:{'X-Demo-User':String(user)},body:form(valid)})}
const prior=process.env.NODE_ENV;
try{
 process.env.NODE_ENV='development';
 let res=await post('/trips',{mode:'transit',demo:true,demo_destination:'University of Waterloo'});assert.equal(res.status,201);const {id}=await res.json();
 assert.equal((await post(`/trips/${id}/finish`,{})).status,400,'photo required');
 assert.equal((await upload(id,false)).status,400,'invalid image rejected');
 assert.equal((await upload(id,true,2)).status,404,'another user cannot upload');
 assert.equal((await upload(id)).status,201);
 assert.equal((await post(`/trips/${id}/points`,{points:[]})).status,400,'no GPS on demo trips');
 const restored=await (await app.request('/api/trips',{headers:{'X-Demo-User':'1'}})).json();assert.equal(restored.trips[0].evidence_status,'submitted');
 res=await post(`/trips/${id}/finish`,{});assert.equal(res.status,200);const done=await res.json();assert.equal(done.trip.demo,true);assert.equal(done.trip.points_awarded,77);
 assert.equal((await post(`/trips/${id}/finish`,{})).status,409,'finish is not paid twice');assert.equal((await upload(id)).status,409);
 const user=db.prepare('SELECT points,trust_multiplier,eco_score FROM users WHERE id=1').get() as any;assert.equal(user.points,177);assert.equal(user.trust_multiplier,1);assert.equal(user.eco_score,100);
 assert.equal((await post('/trips',{mode:'walk',demo:true,demo_destination:'Unknown'})).status,400);
 process.env.NODE_ENV='production';delete process.env.DEMO_TRIPS_ENABLED;
 assert.equal((await post('/trips',{mode:'walk',demo:true,demo_destination:'Kitchener City Hall'})).status,403);
 console.log('Evidence: ownership, upload validation, resume, demo finish, idempotency, real metrics, production guard passed.');
}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;db.close()}
