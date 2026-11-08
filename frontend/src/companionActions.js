// One allow-listed action boundary shared by Gemini and ElevenLabs. No model URLs,
// code, arbitrary API paths, or unconfirmed purchases are executed by the browser.
export const pageNames=['Home','Explore','Rewards','Wallet','Community'];
export function validAction(action){
 if(!action||typeof action!=='object')return false;
 switch(action.type){
  case 'navigate':return pageNames.includes(action.page);
  case 'plan_trip':return typeof action.destination==='string'&&action.destination.trim().length>0&&action.destination.length<=200&&(action.origin_name===undefined||typeof action.origin_name==='string'&&action.origin_name.length<=120)&&(action.mode===undefined||['walk','bike','transit'].includes(action.mode));
  case 'start_trip':return ['walk','bike','scooter','transit','car'].includes(action.mode);
  case 'finish_trip':return true;
  case 'redeem_reward':return Number.isInteger(action.reward_id)&&action.reward_id>0;
  default:return false;
 }
}
export function voiceResultAction(event){
 if(event.is_error||event.truncated||typeof event.full_tool_result!=='string')return null;
 let data;try{data=JSON.parse(event.full_tool_result)}catch{return null}
 if(data.ok!==true)return null;
 if(event.tool_name==='plan_trip'&&data.options&&data.destination)return {type:'show_plan',plan:data};
 if(event.tool_name==='redeem_reward'&&data.redemption)return {type:'refresh',page:'Wallet'};
 if(event.tool_name==='get_rewards')return {type:'navigate',page:'Rewards'};
 if(event.tool_name==='get_status')return {type:'refresh'};
 return null;
}
