import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {renderHook,act,waitFor,cleanup} from '@testing-library/react';
import {completePhotoTrip,readPhotoTrips,photoTripsKey} from '../photoTrips';
import useBackend from '../useBackend';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
beforeEach(()=>localStorage.clear());afterEach(()=>{cleanup();vi.clearAllMocks()});
const trip=(id,mode='transit',distance_km=1.2)=>({id,mode,distance_km,status:'active',demo:true});
it.each([['walk',12],['bike',7],['transit',14]])('awards %s points using its per-km rate, persisting exactly once', (mode,points)=>{
 expect(completePhotoTrip(trip('one',mode)).points_awarded).toBe(points);expect(completePhotoTrip(trip('one',mode)).points_awarded).toBe(points);expect(readPhotoTrips()).toHaveLength(1);expect(JSON.parse(localStorage.getItem(photoTripsKey))[0].points_awarded).toBe(points);
});
it('caps points at 200 a day across server and browser trips',()=>{
 expect(completePhotoTrip(trip('one','walk',2),195).points_awarded).toBe(5);expect(completePhotoTrip(trip('two','transit',5),195).points_awarded).toBe(0);
});
it('updates the wallet and trip history immediately, then retains points across refresh and remount',async()=>{
 api.mockImplementation(async path=>path==='/me'?{points:3200,points_today:5,eco_score:98}:path==='/rewards'?{rewards:[]}:path==='/redemptions'?{redemptions:[]}:path==='/clubs'?{clubs:[]}:{trips:[]});
 const first=renderHook(()=>useBackend());await waitFor(()=>expect(first.result.current.me?.points).toBe(3200));
 act(()=>{completePhotoTrip(trip('one'))});expect(first.result.current.me.points).toBe(3214);expect(first.result.current.me.points_today).toBe(19);expect(first.result.current.trips[0].points_awarded).toBe(14);expect(first.result.current.serverMe.points).toBe(3200);
 await act(async()=>{await first.result.current.refresh()});expect(first.result.current.me.points).toBe(3214);first.unmount();
 const next=renderHook(()=>useBackend());await waitFor(()=>expect(next.result.current.me?.points).toBe(3214));
});
