import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {renderHook,act,waitFor,cleanup} from '@testing-library/react';
import useTripTracker from '../useTripTracker';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
let gpsCallback;
const point=()=>({coords:{latitude:43.45,longitude:-80.49,accuracy:5},timestamp:Date.now()});
const geo={getCurrentPosition:vi.fn(),watchPosition:vi.fn(),clearWatch:vi.fn()};
beforeEach(()=>{api.mockReset();geo.getCurrentPosition.mockClear();geo.watchPosition.mockClear();Object.defineProperty(navigator,'geolocation',{value:geo,configurable:true});geo.getCurrentPosition.mockImplementation(resolve=>resolve(point()));geo.watchPosition.mockImplementation(cb=>{gpsCallback=cb;queueMicrotask(()=>cb(point()));return 42});geo.clearWatch.mockReset();api.mockImplementation(async(path)=>path==='/trips'?{trips:[]}:{});});
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
it('starts a photo demo without requesting GPS and uploads multipart evidence',async()=>{
 api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:30,mode:'transit',demo:true}:{trips:[]}):path.endsWith('/evidence')?{evidence_status:'submitted'}:{trip:{demo:true,points_awarded:11}});
 const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});
 await act(async()=>{await result.current.start('Transit',{demo:true,destination:'Kitchener GO station'})});
 expect(geo.watchPosition).not.toHaveBeenCalled();expect(geo.getCurrentPosition).not.toHaveBeenCalled();expect(result.current.trip.demo).toBe(true);
 const photo=new File(['photo'],'ticket.png',{type:'image/png'});await act(async()=>{await result.current.uploadEvidence(photo)});
 expect(api.mock.calls.find(([path])=>path.endsWith('/evidence'))[1].get('photo').name).toBe('ticket.png');expect(result.current.trip.evidence_status).toBe('submitted');
 await act(async()=>{await result.current.finish()});expect(result.current.trip).toBe(null);
});
