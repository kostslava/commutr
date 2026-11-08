import React from 'react';
export default function NavIcon({name,active}){
 const ink='#063c28',paper='#fffdf1',fill=active?ink:paper,detail=active?paper:ink;
 return <svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke={ink} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
 {name==='Home'?<><path fill={fill} d="M8 28 30 7q2-2 4 0l22 21v27q0 4-5 4H40V40q0-5-8-5t-8 5v19H13q-5 0-5-4Z"/><path d="M25 58V42q0-6 7-6t7 6v16" stroke={active?paper:ink}/>{active&&<path d="M25 22h14" stroke={paper}/>}</>:
 name==='Wallet'?<><path d="M20 18v-4q0-11 11-11t11 11v4"/><path fill={fill} d="M10 20q0-3 5-3h34q6 0 6 6v31q0 5-6 5H14q-7 0-7-7V27q0-7 7-7Z"/><path fill={paper} d="M44 33h14v15H44q-9 0-9-8t9-7Z"/><circle cx="45" cy="40" r="2" fill={ink} stroke="none"/><path d="M25 12h11" strokeWidth="3"/></>:
 name==='Community'?<><path fill={fill} d="M8 19Q8 7 20 7h26q12 0 12 12v24q0 11-12 11H27L12 61l1-13q-5-2-5-11Z"/><path fill={detail} stroke={detail} strokeWidth="3" d="m32 18 5 10 10 5-10 5-5 10-5-10-10-5 10-5Z"/></>:
 name==='Explore'?<><path fill={fill} d="m5 16 17-9 21 9L59 8v42l-17 9-20-9-17 8Z"/><path stroke={detail} strokeWidth="5" d="M22 10v38m20-29v37"/><path fill={detail} stroke="none" d="M32 23q-8 0-8 8 0 6 8 15 8-9 8-15 0-8-8-8m0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6" fillRule="evenodd"/></>:
 <><path d="M19 20v-5q0-12 13-12t13 12v5"/><path fill={fill} d="M13 21q-3 0-4 5L5 52q-1 7 7 7h40q8 0 7-7l-4-26q-1-5-5-5Z"/>{active&&<path d="M20 29h24l3 21H17Z" fill={paper} stroke={paper} strokeWidth="2"/>}</>}
 </svg>
}
