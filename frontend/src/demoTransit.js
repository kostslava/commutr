// Rehearsal routes from the demo home's downtown Kitchener location.
// Illustrative paths and timings, never presented as a live GRT timetable.
export const places=[
 {name:'Kitchener City Hall',lat:43.4516,lng:-80.4925,minutes:5,km:.4},
 {name:'Victoria Park, Kitchener',lat:43.4464,lng:-80.4936,minutes:9,km:1.1},
 {name:'Kitchener Market',lat:43.4469,lng:-80.4846,minutes:10,km:1.2},
 {name:'Waterloo Public Library',lat:43.4665,lng:-80.5243,minutes:24,km:4.2},
 {name:'University of Waterloo',lat:43.4723,lng:-80.5449,minutes:32,km:6.4},
 {name:'Kitchener GO station',lat:43.4557,lng:-80.4931,minutes:8,km:.9},
];
export function demoTransit(destination,origin){
 const place=places.find(p=>Math.abs(p.lat-destination?.lat)<.0001&&Math.abs(p.lng-destination?.lng)<.0001);
 if(!place||Math.abs(origin.lat-43.450696)>.002||Math.abs(origin.lng+80.492268)>.002)return null;
 const path=[[origin.lat,origin.lng],[43.4513,-80.4925],[place.lat,place.lng]];
 return {mode:'transit',minutes:place.minutes,km:place.km,points_estimate:Math.round(place.km*12),demo:true,path,
  next_bus:{route:'Demo bus',minutes:3,source:'demo'},
  steps:['Walk to the downtown stop.','Demo bus departs in 3 minutes.',`Ride toward ${place.name}, then walk to your destination.`,'Illustrative route and timing for the demo; check GRT for actual service.']};
}
