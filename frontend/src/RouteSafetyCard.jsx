import React from 'react';
const labels={lighting:'Lighting',sidewalks:'Sidewalks',traffic:'Traffic',crossings:'Crossings'};
export default function RouteSafetyCard({safety}){
 if(!safety?.available)return null;
 return <section className="route-safety" aria-label="Route safety rating" role="status"><h3>Route safety <span>{safety.rating.overall} · {safety.rating.score}/5</span></h3><dl>{Object.entries(labels).map(([key,label])=><div key={key}><dt>{label} · {safety.rating.factors[key].rating}</dt><dd>{safety.rating.factors[key].note}</dd></div>)}</dl><p>{safety.note}</p><footer>{safety.attribution.map((line,i)=><div key={i}>{line}</div>)}</footer></section>
}
