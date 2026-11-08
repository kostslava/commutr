import {Type,type FunctionDeclaration} from '@google/genai';
import {geocode} from '../planner/geocode.js';
export const DISCOVER_TOOL:FunctionDeclaration={name:'discover_places',description:'Find real places beyond the preset destinations in Kitchener-Waterloo. Use for boredom, date ideas, somewhere new, food, walks, parks, museums or cafes. Search a category and town, or verify a named place. Suggest only returned places; never invent hours, prices, events or availability.',parameters:{type:Type.OBJECT,properties:{query:{type:Type.STRING,description:'Public place name or category with a KW town, e.g. parks in Waterloo, cafes in Kitchener, museums in Kitchener.'}},required:['query']}};
export async function discoverPlaces(query:unknown){
 if(typeof query!=='string'||!query.trim()||query.length>160)return {ok:false,summary:'What kind of place are you in the mood for?'};
 const found=await geocode(query.trim(),5000);
 if(!found.ok)return {ok:false,summary:'Place search is unavailable right now. Ask for a different kind of outing or try again shortly.'};
 return {ok:true,places:found.results.map(p=>({name:p.name,town:p.town})),summary:found.results.length?'These are mapped places in KW. Suggest one or two that suit the request, then offer to plan a route. Opening hours, prices and events have not been checked.':'No matching places found. Try a nearby town, a more specific category or a landmark name.',attribution:'© OpenStreetMap contributors (Nominatim)'};
}
