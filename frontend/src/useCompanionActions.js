import {api} from './api';
import {validAction} from './companionActions';
export default function companionActions({navigate,setRoute,setMode,tracker,backend}){
 return async function execute(action){
  // These internal events only come from parsed provider results, never model text.
  if(action.type==='refresh'){await backend.refresh();if(action.page)navigate(action.page);return {summary:'Account updated.'}}
  if(action.type==='show_plan'){if(!action.plan?.destination?.name||!Array.isArray(action.plan.options))throw new Error('Invalid trip plan');setRoute({...action.plan,id:crypto.randomUUID()});navigate('Explore');return {summary:action.plan.summary}}
  if(!validAction(action))return {ok:false,summary:'That action isn’t available. Try a route, rewards, wallet or community.'};
  if(action.type==='navigate'){navigate(action.page);return {ok:true,summary:`Opened ${action.page==='Explore'?'the map':action.page.toLowerCase()}.`}}
  if(action.type==='plan_trip'){
   const plan=await api('/companion/plan',{destination:action.destination,...(action.origin_name?{origin_name:action.origin_name}:{})});setRoute({...plan,id:crypto.randomUUID()});const selected=plan.options?.find(o=>o.mode===action.mode),chosen=selected?.mode||plan.recommendation;if(!tracker.trip&&chosen)setMode({walk:'Walk',bike:'Bike',transit:'Transit'}[chosen]||'Bike');navigate('Explore');return {ok:true,summary:selected?`From ${plan.origin_name}, ${selected.mode} takes about ${selected.minutes} minutes and earns about ${selected.points_estimate} points.`:plan.summary,origin_name:plan.origin_name,destination:plan.destination,options:plan.options,recommendation:plan.recommendation,selected_mode:chosen};
  }
  if(action.type==='start_trip'){
   if(tracker.trip)return {ok:false,summary:'You already have a trip in progress. Open the map to resume it.'};
   navigate('Explore');const trip=await tracker.start(action.mode);return trip?{ok:true,summary:`Your ${action.mode} trip is recording. Keep Commutr open.`}:{ok:false,summary:'Trip did not start. Check the location message on the map.'};
  }
  if(action.type==='finish_trip'){
   if(!tracker.trip)return {ok:false,summary:'There’s no active trip to finish.'};
   if(action.expected_trip_id!==undefined&&tracker.trip.id!==action.expected_trip_id)return {ok:false,summary:'The active trip changed. Ask me to finish the new trip instead.'};
   const result=await tracker.finish();navigate('Explore');return result?{ok:true,summary:`Trip finished. You earned ${result.trip.points_awarded} points.`}:{ok:false,summary:'Couldn’t finish yet. Check the message on the map and retry.'};
  }
  if(action.type==='redeem_reward'){
   // Re-read the catalogue so a model cannot invent an ID, price, or eligibility.
   const catalogue=await api('/rewards'),reward=catalogue.rewards.find(r=>r.id===action.reward_id);
   if(!reward)return {ok:false,summary:'That reward is no longer available.'};navigate('Rewards');
   if(action.expected_points_cost!==undefined&&reward.points_cost!==action.expected_points_cost)return {ok:false,summary:'The reward price changed. Ask again so I can confirm the new cost.'};
   if(reward.locked||!reward.affordable||reward.redeemed_today)return {ok:false,summary:'This reward is locked, unaffordable or already redeemed today. Check the shop for the requirements.'};
   const result=await api(`/rewards/${reward.id}/redeem`,{});await backend.refresh();navigate('Wallet');return {ok:true,summary:`Redeemed ${result.redemption.title}. Your code is ${result.redemption.code}. It’s saved in your wallet.`};
  }
 };
}
