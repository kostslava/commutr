import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import TripEvidence from '../TripEvidence';
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('uses local demo submission for the upload button, including old real trip IDs',async()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:photo'),revokeObjectURL:vi.fn()}));
 const uploadEvidence=vi.fn().mockResolvedValue({evidence_status:'submitted'}),photo=new File(['photo'],'ticket.png',{type:'image/png'});
 const {rerender}=render(<TripEvidence tracker={{trip:{id:12},uploadEvidence}}/>);
 fireEvent.change(screen.getByLabelText('Trip evidence photo'),{target:{files:[photo]}});
 fireEvent.click(screen.getByRole('button',{name:'Upload photo'}));
 await waitFor(()=>expect(uploadEvidence).toHaveBeenCalledWith(photo,{demo:true}));
 rerender(<TripEvidence tracker={{trip:{id:12,evidence_status:'submitted',evidence_local:true},uploadEvidence}}/>);
 expect(await screen.findByRole('button',{name:'Photo uploaded · replace'})).toBeTruthy();expect(screen.queryByText(/demo/i)).toBeNull();
});

it('shows an uploading spinner and progress bar while submission is in progress',()=>{
 vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:photo'),revokeObjectURL:vi.fn()}));
 const {rerender}=render(<TripEvidence tracker={{trip:{id:12},busy:false,uploadEvidence:vi.fn()}}/>);fireEvent.change(screen.getByLabelText('Trip evidence photo'),{target:{files:[new File(['photo'],'ticket.png',{type:'image/png'})]}});rerender(<TripEvidence tracker={{trip:{id:12},busy:true,uploadEvidence:vi.fn()}}/>);
 expect(screen.getByRole('progressbar',{name:'Uploading photo'})).toBeTruthy();expect(screen.getByRole('button',{name:'Uploading…'}).disabled).toBe(true);expect(screen.getByRole('button',{name:'Remove selected photo'}).disabled).toBe(true);
});
