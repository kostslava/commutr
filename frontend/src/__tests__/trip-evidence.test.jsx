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
 fireEvent.click(screen.getByRole('button',{name:'Upload photo · demo'}));
 await waitFor(()=>expect(uploadEvidence).toHaveBeenCalledWith(photo,{demo:true}));
 rerender(<TripEvidence tracker={{trip:{id:12,evidence_status:'submitted',evidence_local:true},uploadEvidence}}/>);
 expect(await screen.findByRole('button',{name:'Demo photo uploaded · replace'})).toBeTruthy();expect(screen.getByText(/photo stays on this device/)).toBeTruthy();
});
