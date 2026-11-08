import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';
import Wallet from '../Wallet';
vi.mock('../InstallApp',()=>({default:()=>null}));
afterEach(cleanup);
const props={me:{points:1300,eco_score:98},redemptions:[{id:1,title:'Coffee',merchant_name:'Cafe',code:'REWARD'}],trips:[],navigate:vi.fn()};
it('runs the reset once, shows progress, then announces the restored balance',async()=>{
 let resolve;const onReset=vi.fn(()=>new Promise(r=>{resolve=r}));const {rerender}=render(<Wallet {...props} onReset={onReset}/>);
 fireEvent.click(screen.getByRole('button',{name:'Reset wallet'}));expect(onReset).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'Resetting…'}).disabled).toBe(true);
 await act(async()=>{resolve({ok:true})});rerender(<Wallet {...props} me={{points:3200,eco_score:98}} redemptions={[]} onReset={onReset}/>);
 expect(screen.getByRole('status').textContent).toContain('3,200');expect(screen.queryByText('REWARD')).toBeNull();expect(screen.getByText('No rewards yet.')).toBeTruthy();
});
it('shows failure without hiding existing rewards and allows retry',async()=>{
 render(<Wallet {...props} onReset={vi.fn().mockRejectedValue(new Error('Reset unavailable'))}/>);fireEvent.click(screen.getByRole('button',{name:'Reset wallet'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('Reset unavailable'));expect(screen.getByText('REWARD')).toBeTruthy();expect(screen.getByRole('button',{name:'Reset wallet'}).disabled).toBe(false);
});
