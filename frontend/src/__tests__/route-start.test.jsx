import React from 'react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react';
import RouteMap from '../RouteMap';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
vi.mock('leaflet',()=>{
 const layer=()=>({addTo:vi.fn().mockReturnThis(),bindPopup:vi.fn().mockReturnThis(),remove:vi.fn(),clearLayers:vi.fn()});
 return {default:{map:()=>({setView:vi.fn().mockReturnThis(),remove:vi.fn(),invalidateSize:vi.fn()}),tileLayer:layer,layerGroup:layer,circleMarker:layer,marker:layer,divIcon:vi.fn()}};
});
beforeEach(()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 api.mockResolvedValue({vehicles:[],source:'live'});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks()});
it.each(['Walk','Bike','Transit'])('lets users start %s without a route estimate',async(mode)=>{
 const start=vi.fn();
 render(<RouteMap mode={mode} setMode={vi.fn()} destination="" setDestination={vi.fn()} tracker={{trip:null,start}}/>);
 await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Start trip'}));
 expect(start).toHaveBeenCalledWith(mode);
});
it('keeps transit start available when the selected destination has no direct transit option',async()=>{
 const start=vi.fn();
 render(<RouteMap mode="Transit" setMode={vi.fn()} destination="Victoria Park" setDestination={vi.fn()} tracker={{trip:null,start}} agentRoute={{id:1,destination:{name:'Victoria Park'},options:[{mode:'walk',steps:[]}],map_destination:{name:'Victoria Park',lat:43.4464,lng:-80.4936}}}/>);
 expect(screen.getByText('No direct route estimate')).toBeTruthy();
 await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Start trip'}));
 expect(start).toHaveBeenCalledWith('Transit');
});
