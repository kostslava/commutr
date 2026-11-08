import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openDb} from '../src/db.js';
import {currentUser,type CurrentUserEnv} from '../src/currentUser.js';
import {meRoutes} from '../src/routes/me.js';
import {rewardRoutes} from '../src/routes/rewards.js';
const db=openDb(':memory:');
try{
 db.exec(`INSERT INTO users(id,name,email,points,eco_score,trust_multiplier) VALUES(1,'Demo','one@example.test',1200,60,.5),(2,'Other','two@example.test',1400,88,1);
 INSERT INTO merchants(id,name,category) VALUES(1,'Demo Cafe','cafe');
 INSERT INTO rewards(id,merchant_id,title,points_cost,min_eco_score) VALUES(1,1,'Coffee',100,80);
 INSERT INTO redemptions(id,user_id,reward_id,points_spent,code) VALUES(1,1,1,100,'ONE'),(2,2,1,100,'TWO');
 INSERT INTO trips(id,user_id,mode,status,points_awarded,ended_at) VALUES(1,1,'walk','finished',200,strftime('%Y-%m-%dT%H:%M:%fZ','now')),(2,1,'bike','active',NULL,NULL),(3,2,'walk','active',NULL,NULL);
 INSERT INTO trip_points(trip_id,lat,lng,accuracy,timestamp) VALUES(1,43.45,-80.49,5,'2026-11-08T10:00:00Z');
 INSERT INTO trip_evidence(trip_id,mime_type,photo) VALUES(2,'image/png',X'01');
 INSERT INTO saved_locations(user_id,kind,label,lat,lng) VALUES(1,'home','Home',43.45,-80.49);`);
 const app=new Hono<CurrentUserEnv>();app.use('*',currentUser(db));app.route('/api',meRoutes(db));app.route('/api',rewardRoutes(db));app.onError(()=>new Response('{}',{status:500}));
 const post=(path:string,user=1)=>app.request('/api'+path,{method:'POST',headers:{'X-Demo-User':String(user)}});
 let res=await post('/me/reset');assert.equal(res.status,200);const result=await res.json();assert.equal(result.ok,true);assert.equal(result.me.points,3200);assert.equal(result.me.eco_score,98);assert.equal(result.me.trust_multiplier,1);assert.equal(result.me.points_today,0);assert.equal(result.redemptions.length,0);assert.equal(result.trips.length,0);assert.equal(result.rewards[0].redeemed_today,false);assert.equal(result.rewards[0].affordable,true);
 for(const table of ['trip_points','trip_evidence'])assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM saved_locations WHERE user_id=1').get() as {n:number}).n,1);
 assert.equal((db.prepare('SELECT points FROM users WHERE id=2').get() as {points:number}).points,1400);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE user_id=2').get() as {n:number}).n,1);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM trips WHERE user_id=2').get() as {n:number}).n,1);
 assert.equal((await post('/rewards/1/redeem')).status,201,'reward can be redeemed again after reset');assert.equal((await post('/me/reset',2)).status,403,'other users cannot be reset');
 db.exec(`INSERT INTO trips(id,user_id,mode,status) VALUES(4,1,'walk','active'); CREATE TRIGGER fail_reset BEFORE UPDATE OF points ON users WHEN NEW.points=3200 BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
 assert.equal((await post('/me/reset')).status,500);assert.equal((db.prepare('SELECT points FROM users WHERE id=1').get() as {points:number}).points,3100);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE user_id=1').get() as {n:number}).n,1);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM trips WHERE user_id=1').get() as {n:number}).n,1,'failed reset rolls back activity deletion');
 db.exec('DROP TRIGGER fail_reset');assert.equal((await post('/me/reset')).status,200);assert.equal((await post('/me/reset')).status,200,'reset is idempotent');
 console.log('Account reset: balance, rewards, daily cap, cascade cleanup, isolation, repeat redemption, idempotency and rollback passed.');
}finally{db.close()}
