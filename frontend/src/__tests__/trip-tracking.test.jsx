import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {renderHook,act,waitFor,cleanup} from '@testing-library/react';
import useTripTracker from '../useTripTracker';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
let gpsCallback;
const point=()=>({coords:{latitude:43.45,longitude:-80.49,accuracy:5},timestamp:Date.now()});
const geo={getCurrentPosition:vi.fn(),watchPosition:vi.fn(),clearWatch:vi.fn()};
beforeEach(()=>{api.mockReset();Object.defineProperty(navigator,'geolocation',{value:geo,configurable:true});geo.getCurrentPosition.mockImplementation(resolve=>resolve(point()));geo.watchPosition.mockImplementation(cb=>{gpsCallback=cb;return 42});geo.clearWatch.mockReset();api.mockImplementation(async(path)=>path==='/trips'?{trips:[]}:{});});
afterEach(cleanup);
describe('foreground trip lifecycle',()=>{
 it('requests location before starting a backend trip, uploads ISO points, then scores and refreshes',async()=>{
  const refresh=vi.fn();api.mockImplementation(async(path,body)=>path==='/trips'?(body?{id:9,mode:'transit',status:'active'}:{trips:[]}):path.endsWith('/points')?{accepted:body.points.length}:path.endsWith('/finish')?{points_awarded:18}:{});
  const {result}=renderHook(()=>useTripTracker(refresh));await act(async()=>{});
  await act(async()=>{await result.current.start('Transit')});await waitFor(()=>expect(result.current.samples).toBe(1));
  expect(api).toHaveBeenCalledWith('/trips',{mode:'transit'});expect(result.current.recording).toBe(true);
  const batch=api.mock.calls.find(([p])=>p==='/trips/9/points')[1].points[0];expect(batch.lat).toBe(43.45);expect(Number.isFinite(Date.parse(batch.timestamp))).toBe(true);
  await act(async()=>{gpsCallback(point())});await waitFor(()=>expect(result.current.samples).toBe(2));
  await act(async()=>{await result.current.finish()});expect(geo.clearWatch).toHaveBeenCalledWith(42);expect(api).toHaveBeenCalledWith('/trips/9/finish',{});expect(result.current.trip).toBe(null);expect(refresh).toHaveBeenCalledOnce();
 });
 it('does not start a trip when location permission is denied',async()=>{
  geo.getCurrentPosition.mockImplementation((_,reject)=>reject({code:1,message:'denied'}));const {result}=renderHook(()=>useTripTracker(vi.fn()));await act(async()=>{});await act(async()=>{await result.current.start('Bike')});expect(result.current.error).toMatch(/Allow location/);expect(api.mock.calls.some(([p,b])=>p==='/trips'&&b)).toBe(false);expect(result.current.trip).toBe(null);
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
