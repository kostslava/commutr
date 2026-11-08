// Exact critically damped spring step: interruptions keep position and velocity.
export function stepLogoMotion({position,velocity},target,seconds){
 const frequency=13,offset=position-target,impulse=velocity+frequency*offset;
 const decay=Math.exp(-frequency*seconds);
 return {position:target+(offset+impulse*seconds)*decay,velocity:(velocity-frequency*impulse*seconds)*decay};
}
