import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {renderHook,act,waitFor,cleanup} from '@testing-library/react';
import useTripTracker from '../useTripTracker';
import companionActions from '../useCompanionActions';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
let gpsCallback;
const point=()=>({coords:{latitude:43.45,longitude:-80.49,accuracy:5},timestamp:Date.now()});
const geo={getCurrentPosition:vi.fn(),watchPosition:vi.fn(),clearWatch:vi.fn()};
beforeEach(()=>{sessionStorage.clear();localStorage.clear();api.mockReset();geo.getCurrentPosition.mockClear();geo.watchPosition.mockClear();Object.defineProperty(navigator,'geolocation',{value:geo,configurable:true});geo.getCurrentPosition.mockImplementation(resolve=>resolve(point()));geo.watchPosition.mockImplementation(cb=>{gpsCallback=cb;queueMicrotask(()=>cb(point()));return 42});geo.clearWatch.mockReset();api.mockImplementation(async(path)=>path==='/trips'?{trips:[]}:{});});
afterEach(cleanup);
describe('foreground trip lifecycle',()=>{
 it('does not prompt on mount and coalesces repeated start requests',async()=>{
  api.mockImplementation(async(path,body)=>body?{id:22,mode:'walk',status:'active'}:{trips:[]});
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});
  expect(geo.watchPosition).not.toHaveBeenCalled();expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  await act(async()=>{await Promise.all([result.current.start('Walk'),result.current.start('Walk')])});
  expect(geo.watchPosition).toHaveBeenCalledOnce();expect(geo.getCurrentPosition).not.toHaveBeenCalled();
 });
 it('requests location once when starting a backend trip, uploads ISO points, then scores and refreshes',async()=>{
  const refresh=vi.fn();api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:9,mode:'transit',status:'active'}:{trips:[]}):path.endsWith('/points')?{accepted:body.points.length}:path.endsWith('/finish')?{points_awarded:18}:{});
  const {result}=renderHook(()=>useTripTracker(refresh));await act(async()=>{});
  await act(async()=>{await result.current.start('Transit')});await waitFor(()=>expect(result.current.samples).toBe(1));
  expect(api).toHaveBeenCalledWith('/trips',{mode:'transit'});expect(result.current.recording).toBe(true);
  const batch=api.mock.calls.find(([p])=>p==='/trips/9/points')[1].points[0];expect(batch.lat).toBe(43.45);expect(Number.isFinite(Date.parse(batch.timestamp))).toBe(true);
  await act(async()=>{gpsCallback(point())});await waitFor(()=>expect(result.current.samples).toBe(2));
  await act(async()=>{await result.current.finish()});expect(geo.clearWatch).toHaveBeenCalledWith(42);expect(api).toHaveBeenCalledWith('/trips/9/finish',{});expect(result.current.trip).toBe(null);expect(refresh).toHaveBeenCalledOnce();
 });
 it.each(['Walk','Bike','Transit'])('starts %s while GPS is acquiring a fix, then uploads only real positions',async(mode)=>{
  geo.watchPosition.mockImplementation(cb=>{gpsCallback=cb;return 42});
  api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:20,mode:body.mode,status:'active'}:{trips:[]}):{accepted:body.points.length});
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});
  await act(async()=>{await result.current.start(mode)});
  expect(result.current.trip?.mode).toBe(mode.toLowerCase());expect(result.current.recording).toBe(true);expect(result.current.waitingForLocation).toBe(true);
  expect(result.current.error).toBe('');expect(api.mock.calls.some(([p])=>p.endsWith('/points'))).toBe(false);
  expect(geo.getCurrentPosition).not.toHaveBeenCalled();expect(geo.watchPosition).toHaveBeenCalledWith(expect.any(Function),expect.any(Function),expect.objectContaining({enableHighAccuracy:false,maximumAge:30000}));
  await act(async()=>{gpsCallback(point())});
  await waitFor(()=>expect(result.current.samples).toBe(1));expect(result.current.waitingForLocation).toBe(false);
 });
 it('recovers from a watch timeout and reports denied tracking access',async()=>{
  let watchError;geo.watchPosition.mockImplementation((cb,reject)=>{gpsCallback=cb;watchError=reject;return 42});
  api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:21,mode:body.mode,status:'active'}:{trips:[]}):{accepted:body.points.length});
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});await act(async()=>{await result.current.start('Walk')});
  await act(async()=>{watchError({code:3,message:'Timeout expired'})});expect(result.current.waitingForLocation).toBe(true);expect(result.current.error).not.toMatch(/Timeout expired/);
  await act(async()=>{gpsCallback(point())});await waitFor(()=>expect(result.current.error).toBe(''));expect(result.current.waitingForLocation).toBe(false);
  await act(async()=>{watchError({code:1,message:'denied'})});expect(result.current.recording).toBe(false);expect(result.current.error).toMatch(/Allow location/);expect(geo.clearWatch).toHaveBeenCalledWith(42);
 });
 it('does not start a trip when location permission is denied',async()=>{
  Object.defineProperty(navigator,'permissions',{value:{query:vi.fn().mockResolvedValue({state:'denied'})},configurable:true});const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});await act(async()=>{await result.current.start('Bike')});expect(result.current.error).toMatch(/Location is blocked/);expect(geo.watchPosition).not.toHaveBeenCalled();expect(api.mock.calls.some(([p,b])=>p==='/trips'&&b)).toBe(false);expect(result.current.trip).toBe(null);delete navigator.permissions;
 });
 it('resumes an existing trip without creating another and retries a failed GPS upload before finishing',async()=>{
  let uploads=0;api.mockImplementation(async(path,body)=>path==='/trips'?{trips:[{id:11,mode:'walk',status:'active'}]}:path.endsWith('/points')?(++uploads===1?Promise.reject(new Error('offline')):{accepted:body.points.length}):{points_awarded:4});
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await waitFor(()=>expect(result.current.trip?.id).toBe(11));await act(async()=>{await result.current.start('walk')});await waitFor(()=>expect(result.current.error).toMatch(/upload paused/));await act(async()=>{await result.current.finish()});expect(uploads).toBe(2);expect(api.mock.calls.some(([p,b])=>p==='/trips'&&b)).toBe(false);expect(result.current.trip).toBe(null);
 });
 it('retains the active trip when uploads still fail and makes recording resumable',async()=>{
  api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:12,mode:'bike',status:'active'}:{trips:[]}):Promise.reject(new Error('offline')));
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});await act(async()=>{await result.current.start('Bike')});await act(async()=>{await result.current.finish()});expect(result.current.trip.id).toBe(12);expect(result.current.recording).toBe(false);expect(result.current.error).toMatch(/Reconnect/);expect(api.mock.calls.some(([p])=>p.endsWith('/finish'))).toBe(false);
 });
});
it('completes a local photo demo without a server trip, upload or GPS and awards distance-based points',async()=>{
 const refresh=vi.fn();const {result}=renderHook(()=>useTripTracker(refresh));await act(async()=>{});api.mockClear();
 await act(async()=>{await result.current.start('Transit',{demo:true,destination:'Kitchener GO station',distance_km:1.2})});
 expect(geo.watchPosition).not.toHaveBeenCalled();expect(geo.getCurrentPosition).not.toHaveBeenCalled();expect(result.current.trip.demo).toBe(true);
 await act(async()=>{await result.current.finish()});expect(result.current.error).toContain('Add a photo');expect(result.current.trip).not.toBeNull();
 const photo=new File(['photo'],'ticket.png',{type:'image/png'});await act(async()=>{await result.current.uploadEvidence(photo)});
 expect(result.current.trip.evidence_status).toBe('submitted');expect(result.current.trip.evidence_local).toBe(true);
 let finished;await act(async()=>{finished=await result.current.finish()});expect(finished.trip).toMatchObject({local_demo:true,points_awarded:14,distance_km:1.2});expect(result.current.trip).toBe(null);expect(api).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
});
it('accepts a demo photo for stale trip 12 without contacting its missing upload endpoint',async()=>{
 api.mockImplementation(async(path)=>path==='/trips'?{trips:[{id:12,mode:'bike',status:'active'}]}:Promise.reject(new Error('No trip 12')));
 const {result}=renderHook(()=>useTripTracker(vi.fn()));await waitFor(()=>expect(result.current.trip?.id).toBe(12));api.mockClear();
 await act(async()=>{await result.current.uploadEvidence(new File(['photo'],'bike.png',{type:'image/png'}),{demo:true})});
 expect(api).not.toHaveBeenCalled();expect(result.current.error).toBe('');expect(result.current.trip.evidence_status).toBe('submitted');
});
it('keeps real photo uploads on the backend when demo submission is not requested',async()=>{
 api.mockImplementation(async(path)=>path==='/trips'?{trips:[{id:14,mode:'walk',status:'active'}]}:{evidence_status:'submitted'});
 const {result}=renderHook(()=>useTripTracker(vi.fn()));await waitFor(()=>expect(result.current.trip?.id).toBe(14));
 await act(async()=>{await result.current.uploadEvidence(new File(['photo'],'walk.png',{type:'image/png'}))});
 expect(api.mock.calls.find(([path])=>path==='/trips/14/evidence')[1].get('photo').name).toBe('walk.png');
});
it('does not restore an old server demo after completing it locally',async()=>{
 api.mockResolvedValue({trips:[{id:12,mode:'transit',status:'active',demo:true,demo_destination:'Kitchener GO station'}]});
 const first=renderHook(()=>useTripTracker(vi.fn()));await waitFor(()=>expect(first.result.current.trip?.id).toBe(12));
 await act(async()=>{await first.result.current.uploadEvidence(new File(['photo'],'ticket.png',{type:'image/png'}))});await act(async()=>{await first.result.current.finish()});first.unmount();
 const next=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});expect(next.result.current.trip).toBeNull();
});

it('awards photo points for an existing GPS trip without finishing it on the server',async()=>{
 api.mockResolvedValue({trips:[{id:12,mode:'bike',status:'active',started_at:'2026-11-08T08:00:00Z'}]});
 const first=renderHook(()=>useTripTracker(vi.fn(),{points_today:0}));await waitFor(()=>expect(first.result.current.trip?.id).toBe(12));api.mockClear();
 await act(async()=>{await first.result.current.uploadEvidence(new File(['photo'],'bike.png',{type:'image/png'}),{demo:true,distance_km:1.2})});
 let finished;await act(async()=>{finished=await first.result.current.finish()});expect(finished.trip.points_awarded).toBe(7);expect(first.result.current.trip).toBeNull();expect(api).not.toHaveBeenCalled();first.unmount();
 const next=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});expect(next.result.current.trip).toBeNull();
});

it('shows review before crediting points and ignores duplicate finish requests',async()=>{
 api.mockResolvedValue({trips:[{id:81,mode:'walk',demo:true,status:'active',distance_km:1,evidence_status:'submitted'}]});
 const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});vi.useFakeTimers();
 try{
  let finished;act(()=>{finished=result.current.finish()});expect(result.current.reviewing).toBe(true);expect(result.current.busy).toBe(true);expect(localStorage.getItem('commutr:photo-trips:v1:user:1')).toBeNull();
  await act(async()=>{expect(await result.current.finish()).toBeUndefined();await vi.advanceTimersByTimeAsync(2199)});expect(result.current.trip).not.toBeNull();expect(localStorage.getItem('commutr:photo-trips:v1:user:1')).toBeNull();
  let awarded;await act(async()=>{await vi.advanceTimersByTimeAsync(1);awarded=await finished});expect(awarded.trip.points_awarded).toBe(10);expect(result.current.reviewing).toBe(false);expect(result.current.busy).toBe(false);expect(JSON.parse(localStorage.getItem('commutr:photo-trips:v1:user:1'))).toHaveLength(1);
 }finally{vi.useRealTimers()}
});

it.each(['blocked','unavailable'])('Muta starts the planned route when location is %s',async(location)=>{
 Object.defineProperty(navigator,'permissions',{value:{query:vi.fn().mockResolvedValue({state:'denied'})},configurable:true});if(location==='unavailable')Object.defineProperty(navigator,'geolocation',{value:undefined,configurable:true});
 try{
  const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});const navigate=vi.fn();
  const execute=companionActions({tracker:result.current,navigate,getMapRoute:()=>({destination:{name:'Kitchener Market'},options:[{mode:'walk',km:1.3},{mode:'bike',km:.9}]})});
  let response;await act(async()=>{response=await execute({type:'start_trip',mode:'bike'})});
  expect(response).toMatchObject({ok:true,tracking:'photo'});expect(response.summary).not.toContain('recording');expect(result.current.trip).toMatchObject({mode:'bike',demo:true,demo_destination:'Kitchener Market',distance_km:.9});expect(result.current.error).toBe('');expect(geo.watchPosition).not.toHaveBeenCalled();expect(navigator.permissions.query).not.toHaveBeenCalled();expect(api.mock.calls.some(([path,body])=>path==='/trips'&&body)).toBe(false);expect(navigate).toHaveBeenCalledWith('Explore');
 }finally{delete navigator.permissions}
});
