import {it,expect,vi,afterEach} from 'vitest';import {renderHook,act,waitFor,cleanup} from '@testing-library/react';import useBackend from '../useBackend';import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));afterEach(()=>{cleanup();api.mockReset();localStorage.clear();sessionStorage.clear()});
const response=(path,points)=>path==='/me'?{points,eco_score:90}:path==='/rewards'?{rewards:[]}:path==='/redemptions'?{redemptions:[]}:path==='/clubs'?{clubs:[]}:{trips:[]};
it('a slower old refresh cannot overwrite a newer server balance',async()=>{let resolveOld,reads=0;api.mockImplementation(path=>path==='/me'&&reads++===0?new Promise(resolve=>{resolveOld=resolve}):Promise.resolve(response(path,222)));const{result}=renderHook(()=>useBackend());await act(async()=>{await result.current.refresh()});expect(result.current.me.points).toBe(222);await act(async()=>{resolveOld({points:111,eco_score:90})});expect(result.current.me.points).toBe(222)});
it('reports an API failure while retaining the last confirmed server balance',async()=>{api.mockImplementation(path=>Promise.resolve(response(path,333)));const{result}=renderHook(()=>useBackend());await waitFor(()=>expect(result.current.me?.points).toBe(333));api.mockRejectedValue(new Error('offline'));await act(async()=>{await result.current.refresh()});expect(result.current.error).toBe('offline');expect(result.current.me.points).toBe(333)});
it('resets server data and browser points, and ignores an older refresh afterward',async()=>{
 localStorage.clear();let points=1300,hold=false,resolveOld;
 api.mockImplementation(async path=>{
  if(path==='/me/reset'){points=3200;return {ok:true,me:{points:3200,eco_score:98,points_today:0},rewards:[{id:1,affordable:true,redeemed_today:false}],redemptions:[],clubs:[],trips:[]}}
  if(path==='/me'&&hold)return new Promise(resolve=>{resolveOld=resolve});
  if(path==='/redemptions')return {redemptions:[{id:1,title:'Coffee'}]};return response(path,points);
 });
 const {result}=renderHook(()=>useBackend());await waitFor(()=>expect(result.current.me?.points).toBe(1300));
 act(()=>{localStorage.setItem('commutr:photo-trips:v1:user:1',JSON.stringify([{id:'photo',points_awarded:10}]));window.dispatchEvent(new Event('commutr:photo-trips-changed'))});
 hold=true;let stale;act(()=>{stale=result.current.refresh()});await act(async()=>{});await act(async()=>{await result.current.resetWallet()});
 expect(api).toHaveBeenCalledWith('/me/reset',{});expect(result.current.me.points).toBe(3200);expect(result.current.redemptions).toEqual([]);expect(result.current.trips).toEqual([]);expect(result.current.rewards[0].redeemed_today).toBe(false);expect(localStorage.getItem('commutr:photo-trips:v1:user:1')).toBeNull();
 await act(async()=>{resolveOld({points:1300,eco_score:98});await stale});expect(result.current.me.points).toBe(3200);
});
it('keeps the confirmed wallet intact when the reset API fails',async()=>{
 localStorage.clear();api.mockImplementation(async path=>{if(path==='/me/reset')throw new Error('Reset unavailable');return response(path,1300)});
 const {result}=renderHook(()=>useBackend());await waitFor(()=>expect(result.current.me?.points).toBe(1300));localStorage.setItem('commutr:photo-trips:v1:user:1','[]');
 await act(async()=>{await expect(result.current.resetWallet()).rejects.toThrow('Reset unavailable')});expect(result.current.me.points).toBe(1300);expect(localStorage.getItem('commutr:photo-trips:v1:user:1')).toBe('[]');localStorage.clear();
});
