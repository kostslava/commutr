import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import Shop from '../Shop';
afterEach(cleanup);
const offer={id:1,title:'Free coffee and pastry',merchant:{name:'Belmont Bakehouse',category:'bakery'},points_cost:300,min_eco_score:60,affordable:true,locked:false};
it('searches reward categories and expands the original redeemable offer',()=>{
 const redeem=vi.fn();render(<Shop rewards={[offer]} onRedeem={redeem}/>);
 const input=screen.getByRole('textbox',{name:'Search rewards'});fireEvent.focus(input);fireEvent.change(input,{target:{value:'Caf'}});
 fireEvent.click(screen.getByRole('button',{name:'Cafes',exact:true}));
 const summary=screen.getByRole('button',{name:/Free coffee and pastry/});expect(summary.getAttribute('aria-expanded')).toBe('false');fireEvent.click(summary);
 fireEvent.click(screen.getByRole('button',{name:'300 pts · Get it'}));expect(redeem.mock.calls[0][0].id).toBe(1);
 fireEvent.change(input,{target:{value:'nothing matches this'}});expect(screen.getByText('No matches.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Clear reward search'}));expect(screen.getByRole('button',{name:/Free coffee and pastry/})).toBeTruthy();
});
it('keeps an eco-locked offer disabled after expanding it',()=>{
 render(<Shop rewards={[{...offer,locked:true}]} onRedeem={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:/Free coffee and pastry/}));expect(screen.getByRole('button',{name:'60 eco needed'}).disabled).toBe(true);
});
