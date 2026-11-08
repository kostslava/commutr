import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import TripEvidence from '../TripEvidence';
import useTripTracker from '../useTripTracker';
import {api} from '../api';
vi.mock('../api',()=>({api:vi.fn()}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();api.mockReset();localStorage.clear();sessionStorage.clear()});
it('starts submission immediately after selecting a photo, including old trip IDs',async()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:photo'),revokeObjectURL:vi.fn()}));
 const uploadEvidence=vi.fn().mockResolvedValue({evidence_status:'submitted'}),photo=new File(['photo'],'ticket.png',{type:'image/png'});
 const {rerender}=render(<TripEvidence tracker={{trip:{id:12},uploadEvidence}}/>);
 fireEvent.change(screen.getByLabelText('Trip evidence photo'),{target:{files:[photo]}});
 await waitFor(()=>expect(uploadEvidence).toHaveBeenCalledWith(photo,{demo:true}));expect(uploadEvidence).toHaveBeenCalledOnce();
 rerender(<TripEvidence tracker={{trip:{id:12,evidence_status:'submitted',evidence_local:true},uploadEvidence}}/>);
 expect(await screen.findByRole('button',{name:'Photo uploaded · replace'})).toBeTruthy();expect(screen.queryByText(/demo/i)).toBeNull();
});

it('shows an uploading spinner and progress bar while submission is in progress',()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:photo'),revokeObjectURL:vi.fn()}));
 const {rerender}=render(<TripEvidence tracker={{trip:{id:12},busy:false,uploadEvidence:vi.fn()}}/>);fireEvent.change(screen.getByLabelText('Trip evidence photo'),{target:{files:[new File(['photo'],'ticket.png',{type:'image/png'})]}});rerender(<TripEvidence tracker={{trip:{id:12},busy:true,uploadEvidence:vi.fn()}}/>);
 expect(screen.getByRole('progressbar',{name:'Uploading photo'})).toBeTruthy();expect(screen.getByRole('button',{name:'Uploading…'}).disabled).toBe(true);expect(screen.getByRole('button',{name:'Remove selected photo'}).disabled).toBe(true);
});

it('lets a selected photo finish the trip without requiring another upload click',async()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:photo'),revokeObjectURL:vi.fn()}));
 api.mockResolvedValue({trips:[{id:404,mode:'transit',demo:true,status:'active',demo_destination:'Kitchener GO station'}]});
 function PhotoTrip(){const tracker=useTripTracker(vi.fn());return tracker.trip?<><TripEvidence tracker={tracker}/><button disabled={tracker.busy} onClick={()=>tracker.finish()}>Finish trip</button>{tracker.error&&<p role="alert">{tracker.error}</p>}</>:<p>Ready</p>}
 render(<PhotoTrip/>);const input=await screen.findByLabelText('Trip evidence photo');fireEvent.change(input,{target:{files:[new File(['photo'],'ticket.png',{type:'image/png'})]}});
 expect(screen.getByRole('button',{name:'Finish trip'}).disabled).toBe(true);expect(screen.getByRole('progressbar',{name:'Uploading photo'})).toBeTruthy();
 await screen.findByRole('button',{name:'Photo uploaded · replace'},{timeout:3000});fireEvent.click(screen.getByRole('button',{name:'Finish trip'}));await screen.findByText('Ready');expect(screen.queryByRole('alert')).toBeNull();expect(api).toHaveBeenCalledOnce();
});
