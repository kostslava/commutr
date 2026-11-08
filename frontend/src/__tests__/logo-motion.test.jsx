import {describe,it,expect} from 'vitest';
import {stepLogoMotion} from '../logoMotion';

describe('logo navigation motion',()=>{
 it('reverses from its current position and settles exactly without a jump or overshoot',()=>{
  let state={position:0,velocity:0};
  for(let i=0;i<12;i++)state=stepLogoMotion(state,1,1/60);
  expect(state.position).toBeGreaterThan(0);
  expect(state.position).toBeLessThan(1);
  const before=state;
  state=stepLogoMotion(state,0,1/60);
  expect(Math.abs(state.position-before.position)).toBeLessThan(.07);
  for(let i=0;i<120;i++){
   state=stepLogoMotion(state,0,1/60);
   expect(state.position).toBeGreaterThanOrEqual(0);
   expect(state.position).toBeLessThan(1);
  }
  expect(state.position).toBeCloseTo(0,8);
  expect(state.velocity).toBeCloseTo(0,8);
 });
 it('gives the same result across frame rates',()=>{
  let fast={position:0,velocity:0},slow={...fast};
  for(let i=0;i<120;i++)fast=stepLogoMotion(fast,1,1/120);
  for(let i=0;i<30;i++)slow=stepLogoMotion(slow,1,1/30);
  expect(fast.position).toBeCloseTo(slow.position,10);
  expect(fast.velocity).toBeCloseTo(slow.velocity,10);
 });
});
