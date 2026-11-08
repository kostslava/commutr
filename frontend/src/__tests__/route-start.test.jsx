import React from 'react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react';
import RouteMap from '../RouteMap';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
vi.mock('leaflet',()=>{
 const layer=()=>({addTo:vi.fn().mockReturnThis(),bindPopup:vi.fn().mockReturnThis(),remove:vi.fn(),clearLayers:vi.fn()});
 return {default:{map:()=>({setView:vi.fn().mockReturnThis(),remove:vi.fn(),invalidateSize:vi.fn(),fitBounds:vi.fn()}),tileLayer:layer,layerGroup:layer,circleMarker:layer,marker:layer,polyline:layer,latLngBounds:vi.fn(),divIcon:vi.fn()}};
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
 render(<RouteMap mode="Transit" setMode={vi.fn()} destination="Victoria Park" setDestination={vi.fn()} tracker={{trip:null,start}} agentRoute={{id:1,destination:{name:'Victoria Park'},options:[{mode:'walk',steps:[]}],map_destination:{name:'Victoria Park',lat:43.4400,lng:-80.5000}}}/>);
 expect(screen.getByText('No direct route estimate')).toBeTruthy();
 await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Start trip'}));
 expect(start).toHaveBeenCalledWith('Transit');
});

it('shows a usable demo transit option and route details when live planning has no option',async()=>{
 render(<RouteMap mode="Transit" setMode={vi.fn()} destination="" setDestination={vi.fn()} tracker={{trip:null,start:vi.fn()}} agentRoute={{id:2,destination:{name:'University of Waterloo'},options:[],map_destination:{name:'University of Waterloo',lat:43.4723,lng:-80.5449}}}/>);
 await act(async()=>{});
 expect(screen.getByText('32 min · 6.4 km')).toBeTruthy();
 expect(screen.getByText('Demo transit · illustrative timing')).toBeTruthy();
 const details=screen.getByRole('button',{name:'Trip details'});
 expect(details.getAttribute('aria-expanded')).toBe('false');fireEvent.click(details);
 expect(screen.getByText('Ride toward University of Waterloo, then walk to your destination.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Start trip'}).disabled).toBe(false);
});
