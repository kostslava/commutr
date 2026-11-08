import React from 'react';
import {describe,it,expect,vi,afterEach,beforeEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';
import Companion from '../Companion';
import actions from '../useCompanionActions';
import {validAction,voiceResultAction} from '../companionActions';
import {api} from '../api';
const voice=vi.hoisted(()=>({startSession:vi.fn()}));
vi.mock('@elevenlabs/client',()=>({Conversation:voice}));
vi.mock('../api',()=>({api:vi.fn()}));
afterEach(()=>{cleanup();vi.useRealTimers()});
beforeEach(()=>{vi.clearAllMocks();api.mockResolvedValue({reply:'I’m here.',source:'gemini',actions:[]});Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop:vi.fn()}]})}})});
const context={page:'Home',activeTrip:null};
describe('mascot companion',()=>{
 async function liveVoice(execute=vi.fn()){
  const current={endSession:vi.fn(),sendContextualUpdate:vi.fn()};voice.startSession.mockResolvedValue(current);api.mockResolvedValue({signed_url:'wss://example.test/session'});
  render(<Companion execute={execute} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:'Let’s talk'}));await screen.findByLabelText('Mute microphone');return {current,options:voice.startSession.mock.calls[0][0]};
 }
 it.each([
  [Object.assign(new Error('Too many discovery requests. Try again soon.'),{status:429,data:{retry_after_sec:17}}),'Try again in 17 seconds'],
  [Object.assign(new Error('Too many discovery requests. Try again soon.'),{status:429,data:{}}),'Too many discovery requests'],
  [new Error('Network unavailable'),'Network unavailable'],
  [Object.assign(new Error('Places unavailable'),{status:500}),'Places unavailable']
 ])('returns discovery failures as speakable results and keeps the call live',async(error,summary)=>{
  const {current,options}=await liveVoice();api.mockRejectedValueOnce(error);let result;
  await act(async()=>{result=await options.clientTools.discover_places({query:'quiet parks'})});
  expect(result.ok).toBe(false);expect(result.summary).toContain(summary);expect(api).toHaveBeenLastCalledWith('/companion/discover',{query:'quiet parks'});expect(screen.getByLabelText('Mute microphone')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(current.endSession).not.toHaveBeenCalled();
  const places={ok:true,places:[{name:'Waterloo Park'}]};api.mockResolvedValueOnce(places);expect(await options.clientTools.discover_places({query:'parks'})).toBe(places);
 });
 it('includes retry timing on plan errors too',async()=>{
  const execute=vi.fn().mockRejectedValue(Object.assign(new Error('Too many plans'),{status:429,data:{retry_after_sec:12}}));const {options}=await liveVoice(execute);
  expect((await options.clientTools.plan_trip({destination:'Victoria Park'})).summary).toContain('Try again in 12 seconds');
 });
 it('does not report a disconnect for a tool error while the SDK call is live',async()=>{
  const {current,options}=await liveVoice();await act(async()=>{options.onError('Client tool execution failed',{clientToolName:'discover_places'})});expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText('Listening…')).toBeTruthy();expect(screen.getByLabelText('Mute microphone')).toBeTruthy();expect(current.endSession).not.toHaveBeenCalled();
  await act(async()=>{options.onError('Temporary provider error')});expect(screen.queryByText(/call was interrupted|End the call and try again/)).toBeNull();expect(screen.getByLabelText('Mute microphone')).toBeTruthy();
  await act(async()=>{options.onDisconnect({reason:'error',message:'Socket closed'})});expect(screen.getByRole('alert').textContent).toContain('disconnected');expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy();
 });

 it('returns the route-safety JSON from the shared action as the voice tool result',async()=>{
  const result={available:true,summary:'Comfortable sidewalks.',rating:{overall:'good'},attribution:['Mapillary CC BY-SA 4.0']};
  const execute=vi.fn().mockResolvedValue(result);voice.startSession.mockResolvedValue({endSession:vi.fn(),sendContextualUpdate:vi.fn()});api.mockResolvedValue({signed_url:'wss://example.test/session'});
  render(<Companion execute={execute} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:'Let’s talk'}));await screen.findByLabelText('Mute microphone');
  const response=await voice.startSession.mock.calls[0][0].clientTools.get_route_safety({destination:'Victoria Park'});
  expect(execute).toHaveBeenCalledWith({type:'get_route_safety',destination:'Victoria Park'});expect(response).toBe(result);
 });

 it('keeps only the active text conversation, then starts fresh after closing',async()=>{
  render(<Companion execute={vi.fn()} context={context}/>);
  fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:'Let’s type'}));
  fireEvent.change(screen.getByLabelText('Message Muta'),{target:{value:'My points?'}});fireEvent.click(screen.getByLabelText('Send message'));await screen.findByText('I’m here.');
  fireEvent.change(screen.getByLabelText('Message Muta'),{target:{value:'And my streak?'}});fireEvent.click(screen.getByLabelText('Send message'));await waitFor(()=>expect(api).toHaveBeenCalledTimes(2));expect(api.mock.calls[1][1].history).toHaveLength(2);await waitFor(()=>expect(screen.getByLabelText('Message Muta').disabled).toBe(false));
  fireEvent.click(screen.getByLabelText('Close Muta'));fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:'Let’s type'}));expect(screen.queryByText('My points?')).toBeNull();fireEvent.change(screen.getByLabelText('Message Muta'),{target:{value:'Somewhere new?'}});fireEvent.click(screen.getByLabelText('Send message'));await waitFor(()=>expect(api).toHaveBeenCalledTimes(3));expect(api.mock.calls[2][1].history).toEqual([]);
 });
 it('keeps a live voice session through minimize and page changes, then explicitly ends it',async()=>{
  const current={endSession:vi.fn(),sendContextualUpdate:vi.fn(),setMicMuted:vi.fn()};voice.startSession.mockResolvedValue(current);api.mockResolvedValue({signed_url:'wss://example.test/session'});
  const {rerender}=render(<Companion execute={vi.fn()} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:/Let’s talk/}));
  await screen.findByLabelText('Mute microphone');expect(voice.startSession).toHaveBeenCalledOnce();await act(async()=>voice.startSession.mock.calls[0][0].onMessage({role:'user',message:'Never display this voice transcript'}));expect(screen.queryByText('Never display this voice transcript')).toBeNull();expect(screen.queryByRole('log')).toBeNull();fireEvent.click(screen.getByLabelText('Minimize call'));rerender(<Companion execute={vi.fn()} context={{page:'Explore',activeTrip:null}}/>);
  expect(current.endSession).not.toHaveBeenCalled();expect(current.sendContextualUpdate).toHaveBeenCalledWith(expect.stringContaining('Explore'));fireEvent.click(screen.getByLabelText('Reopen Muta call'));fireEvent.click(screen.getByLabelText('Mute microphone'));expect(current.setMicMuted).toHaveBeenCalledWith(true);fireEvent.click(screen.getByRole('button',{name:'End call'}));await waitFor(()=>expect(current.endSession).toHaveBeenCalledOnce());
 });
 it('requires a new spoken yes before the voice finish tool executes',async()=>{
  const current={endSession:vi.fn(),sendContextualUpdate:vi.fn(),setMicMuted:vi.fn()};voice.startSession.mockResolvedValue(current);api.mockResolvedValue({signed_url:'wss://example.test/session'});const execute=vi.fn().mockResolvedValue({ok:true});render(<Companion execute={execute} context={{page:'Explore',activeTrip:'bike',activeTripId:4}}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:'Let’s talk'}));await screen.findByLabelText('Mute microphone');const options=voice.startSession.mock.calls[0][0];let result;await act(async()=>{result=await options.clientTools.finish_trip({confirm:true})});expect(result.code).toBe('voice_confirmation_required');expect(execute).not.toHaveBeenCalled();await act(async()=>{options.onMessage({role:'agent',message:'yes'});await options.clientTools.finish_trip()});expect(execute).not.toHaveBeenCalled();await act(async()=>{options.onMessage({role:'user',message:'yes please'});result=await options.clientTools.finish_trip()});expect(result.ok).toBe(true);expect(execute).toHaveBeenCalledWith({type:'finish_trip',expected_trip_id:4});expect(screen.queryByRole('log')).toBeNull();
 });
 it('cancels a connecting call without letting a late session start',async()=>{
  let resolve;api.mockImplementation(()=>new Promise(r=>resolve=r));render(<Companion execute={vi.fn()} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:/Let’s talk/}));fireEvent.click(screen.getByText('Cancel call'));await act(async()=>resolve({signed_url:'wss://example.test/session'}));expect(voice.startSession).not.toHaveBeenCalled();
 });
 it('times out an unanswered microphone request and keeps typing available',async()=>{
  vi.useFakeTimers();api.mockResolvedValue({signed_url:'wss://example.test/session'});navigator.mediaDevices.getUserMedia.mockImplementation(()=>new Promise(()=>{}));render(<Companion execute={vi.fn()} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:/Let’s talk/}));await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(20001)});expect(screen.getByText(/Microphone permission is still waiting/)).toBeTruthy();expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy();expect(voice.startSession).not.toHaveBeenCalled();
 });
 it('shows microphone denial with a usable text fallback',async()=>{
  api.mockResolvedValue({signed_url:'wss://example.test/session'});navigator.mediaDevices.getUserMedia.mockRejectedValue({name:'NotAllowedError'});render(<Companion execute={vi.fn()} context={context}/>);fireEvent.click(screen.getByLabelText('Open Muta'));fireEvent.click(screen.getByRole('button',{name:/Let’s talk/}));await screen.findByText(/Microphone permission was declined/);fireEvent.click(screen.getByText('Type instead'));expect(await screen.findByLabelText('Message Muta')).toBeTruthy();
 });
});
describe('shared app action boundary',()=>{
 const setup=()=>{const deps={navigate:vi.fn(),setRoute:vi.fn(),setMode:vi.fn(),tracker:{start:vi.fn(),finish:vi.fn()},backend:{refresh:vi.fn()}};return {...deps,execute:actions(deps)}};
 it('rejects arbitrary URLs, APIs and invalid model parameters',async()=>{const d=setup();for(const action of [{type:'navigate',page:'https://example.com'},{type:'fetch',path:'/secrets'},{type:'redeem_reward',reward_id:-1},{type:'start_trip',mode:'plane'}]){expect(validAction(action)).toBe(false);expect((await d.execute(action)).ok).toBe(false)}expect(api).not.toHaveBeenCalled()});
 it('opens a preloaded route with its named origin without starting GPS',async()=>{const d=setup();const plan={destination:{name:'City Hall'},origin_name:'University of Waterloo',recommendation:'bike'};api.mockResolvedValue(plan);await d.execute({type:'plan_trip',destination:'City Hall',origin_name:'University of Waterloo'});expect(api).toHaveBeenCalledWith('/companion/plan',{destination:'City Hall',origin_name:'University of Waterloo'});expect(d.setRoute).toHaveBeenCalledWith(expect.objectContaining(plan));expect(d.navigate).toHaveBeenCalledWith('Explore');expect(d.tracker.start).not.toHaveBeenCalled()});
 it('honors a requested transit mode and returns computed alternatives without map coordinates',async()=>{const d=setup();api.mockResolvedValue({destination:{name:'City Hall'},origin_name:'Campus',recommendation:'bike',options:[{mode:'bike',minutes:12,points_estimate:18},{mode:'transit',minutes:15,points_estimate:40}],map_origin:{lat:43,lng:-80}});const result=await d.execute({type:'plan_trip',destination:'City Hall',mode:'transit'});expect(d.setMode).toHaveBeenCalledWith('Transit');expect(result.summary).toContain('15 minutes');expect(result.options).toHaveLength(2);expect(result.map_origin).toBeUndefined()});
 it('does not spend points on an ineligible reward',async()=>{const d=setup();api.mockResolvedValue({rewards:[{id:2,title:'Coffee',merchant:{name:'Demo'},points_cost:150,affordable:true,locked:true}]});await d.execute({type:'redeem_reward',reward_id:2});expect(api).toHaveBeenCalledTimes(1)});
 it('redeems an eligible requested reward directly and refreshes the wallet',async()=>{const d=setup();api.mockResolvedValueOnce({rewards:[{id:2,title:'Coffee',merchant:{name:'Demo'},points_cost:150,affordable:true}]}).mockResolvedValueOnce({redemption:{title:'Coffee',code:'DEMO'}});await d.execute({type:'redeem_reward',reward_id:2});expect(api).toHaveBeenLastCalledWith('/rewards/2/redeem',{});expect(d.backend.refresh).toHaveBeenCalledOnce();expect(d.navigate).toHaveBeenLastCalledWith('Wallet')});
 it('starts and finishes trips directly through the shared foreground tracker',async()=>{const d=setup();d.tracker.start.mockResolvedValue({id:4});expect((await d.execute({type:'start_trip',mode:'bike'})).ok).toBe(true);expect(d.tracker.start).toHaveBeenCalledWith('bike',{demo:true});const active={...d.tracker,trip:{id:4}};active.finish.mockResolvedValue({trip:{points_awarded:12}});const execute=actions({...d,tracker:active});expect((await execute({type:'finish_trip'})).summary).toContain('12 points');expect(active.finish).toHaveBeenCalledOnce()});
 it('rejects a price or active-trip change at the execution boundary',async()=>{const d=setup();api.mockResolvedValue({rewards:[{id:2,title:'Coffee',merchant:{name:'Demo'},points_cost:200,affordable:true}]});expect((await d.execute({type:'redeem_reward',reward_id:2,expected_points_cost:150})).ok).toBe(false);expect(api).toHaveBeenCalledTimes(1);const execute=actions({...d,tracker:{...d.tracker,trip:{id:9}}});expect((await execute({type:'finish_trip',expected_trip_id:4})).ok).toBe(false);expect(d.tracker.finish).not.toHaveBeenCalled()});
 it('ignores failed, truncated and malformed voice tool results',()=>{expect(voiceResultAction({is_error:true,full_tool_result:'{}'})).toBe(null);expect(voiceResultAction({full_tool_result:'not json'})).toBe(null);expect(voiceResultAction({truncated:true,full_tool_result:'{}'})).toBe(null)});
});
