import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import actions from '../useCompanionActions';
import RouteSafetyCard from '../RouteSafetyCard';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
const rating={available:true,summary:'A comfortable walk.',rating:{overall:'good',score:4,factors:Object.fromEntries(['lighting','sidewalks','traffic','crossings'].map(key=>[key,{rating:'fair',note:key+' note'}]))},note:'Photo conditions can change.',attribution:['Street imagery: Mapillary contributors, CC BY-SA 4.0','Photos by: contributor']};
it('uses the destination name without a planned map route and returns the exact JSON',async()=>{
 const setSafety=vi.fn();api.mockResolvedValue(rating);
 const execute=actions({setSafety});
 expect(await execute({type:'get_route_safety',destination:'Victoria Park'})).toBe(rating);
 expect(api).toHaveBeenCalledWith('/companion/route-safety',{destination:'Victoria Park'});expect(setSafety).toHaveBeenCalledWith(rating);
});
it('uses both planned map endpoints instead of the tool destination',async()=>{
 const route={map_origin:{name:'UW',lat:43.47,lng:-80.54},map_destination:{name:'Square',lat:43.46,lng:-80.52}};api.mockResolvedValue(rating);
 await actions({getMapRoute:()=>route})({type:'get_route_safety',destination:'somewhere else'});
 expect(api).toHaveBeenCalledWith('/companion/route-safety',{origin:{lat:43.47,lng:-80.54},destination:{lat:43.46,lng:-80.52}});
});
it('does not show a rating for no data or a request completed after the route changed',async()=>{
 const setSafety=vi.fn(),unavailable={available:false,summary:'No street photo data.'};api.mockResolvedValue(unavailable);
 expect(await actions({setSafety})({type:'get_route_safety',destination:'Unknown'})).toBe(unavailable);expect(setSafety).toHaveBeenCalledWith(null);
 setSafety.mockClear();let route={};api.mockImplementation(async()=>{route={};return rating});await actions({setSafety,getMapRoute:()=>route})({type:'get_route_safety',destination:'Victoria Park'});expect(setSafety).not.toHaveBeenCalled();
 render(<RouteSafetyCard safety={unavailable}/>);expect(screen.queryByRole('status')).toBeNull();
});
it('shows the overall rating, all factors, note and every attribution line',()=>{
 render(<RouteSafetyCard safety={rating}/>);expect(screen.getByText('good · 4/5')).toBeTruthy();for(const key of ['lighting','sidewalks','traffic','crossings'])expect(screen.getByText(key+' note')).toBeTruthy();expect(screen.getByText(rating.note)).toBeTruthy();for(const line of rating.attribution)expect(screen.getByText(line)).toBeTruthy();
});
