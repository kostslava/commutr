// A model-supplied flag is not consent. A protected voice action needs a new,
// affirmative user transcript after the app has returned the exact question.
export function affirmative(text){
 const value=text.toLowerCase().trim().replace(/[.!?,]+$/g,'');
 if(value.length>140||/\b(no|nope|not|cancel|wait|stop|never)\b|don['’]?t|do not|hold on/.test(value))return false;
 return /^(yes|yeah|yep|yup|sure|okay|ok|absolutely|confirm|go ahead|do it|please do)\b/.test(value);
}
export function createVoiceActionGate({execute,getTripId,getReward,now=Date.now}){
 let turn=0,lastWords='',pending=null;
 return {
  observe(text){turn++;lastWords=typeof text==='string'?text:'';if(!affirmative(lastWords))pending=null},
  reset(){pending=null;lastWords='';turn=0},
  async request(action){
   if(!['finish_trip','redeem_reward'].includes(action.type))return execute(action);
   let key,question,expectedCost,expectedTrip;
   if(action.type==='finish_trip'){
    const id=getTripId();if(!id)return {ok:false,summary:'There’s no active trip to finish.'};
    expectedTrip=id;key=`finish:${id}`;question='Are you done with your trip? Should I finish it now?';
   }else{
    const reward=await getReward(action.reward_id);
    if(!reward)return {ok:false,summary:'That reward is no longer available.'};
    if(reward.locked||!reward.affordable||reward.redeemed_today)return {ok:false,summary:'That reward isn’t available to redeem right now.'};
    expectedCost=reward.points_cost;key=JSON.stringify(['redeem',reward.id,reward.points_cost,reward.title,reward.merchant.name]);
    question=`${reward.title} at ${reward.merchant.name} costs ${reward.points_cost} points. Should I redeem it?`;
   }
   if(pending?.key===key&&turn>pending.turn&&now()<pending.expires&&affirmative(lastWords)){
    pending=null;
    return execute({...action,...(expectedCost!==undefined?{expected_points_cost:expectedCost}:{expected_trip_id:expectedTrip})});
   }
   pending={key,turn,expires:now()+120000};
   return {ok:false,code:'voice_confirmation_required',summary:question,instruction:'Ask this question aloud. Wait for a new explicit yes from the user, then call this same tool again. No on-screen confirmation is needed.'};
  }
 };
}
