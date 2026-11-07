// The Commutr FAQ: canned questions (several wordings each) and short answers.
// Matched locally (see match.ts), no API call. Every number comes from
// scoring/config.ts or rules.ts, never typed in here, so answers stay right when
// the config is tuned. Answers are general (no personal data), so their audio can
// be cached once for everyone. Personal questions ("my points") go to Gemini tools.
//
// Rules for answers: at most 220 characters (tests check), plain text, no emoji,
// no markdown, no real-world facts that go stale (fares, schedules): point to grt.ca.

import * as C from '../scoring/config.js';
import * as R from '../rules.js';
import { MAX_WAV_SECONDS } from './config.js';

export type FaqEntry = { id: string; questions: string[]; answer: string };

const r = C.MODE_RATES;

export const FAQ: FaqEntry[] = [
  // --- Points ---------------------------------------------------------------------
  {
    id: 'points-how',
    questions: ['how do points work', 'how do i earn points', 'how are points calculated', 'how do i get points', 'what are points', 'explain points'],
    answer: `You earn points for every verified kilometre you travel without a car: distance times your mode's rate, times your trip confidence and your trust level. Up to ${C.DAILY_POINTS_CAP} points a day.`,
  },
  {
    id: 'points-rates',
    questions: ['how many points per km', 'what are the point rates', 'how many points for walking', 'which mode gives the most points', 'points per kilometre for bike'],
    answer: `Per kilometre: walking ${r.walk} points, biking ${r.bike}, scooter ${r.scooter}, transit ${r.transit}. Car trips earn ${r.car}.`,
  },
  {
    id: 'points-cap',
    questions: ['is there a daily limit on points', 'what is the daily cap', 'why did my points stop', 'max points per day', 'can i earn unlimited points'],
    answer: `You can earn up to ${C.DAILY_POINTS_CAP} points per day, Toronto time. Trips after you hit the cap still count for streaks, clubs and your eco score.`,
  },
  {
    id: 'points-few',
    questions: ['why did my trip earn so few points', 'why did i get less points than expected', 'why are my points low', 'trip gave fewer points'],
    answer: `Points shrink when the trip looks unusual: odd speeds, GPS jumps, poor accuracy or too few GPS points lower its confidence. Only verified distance counts, and the daily cap of ${C.DAILY_POINTS_CAP} applies.`,
  },
  {
    id: 'points-zero',
    questions: ['why did my trip earn zero points', 'why did i get no points', 'trip gave 0 points', 'no points for my trip'],
    answer: `A trip earns nothing if its confidence is below ${C.LOW_CONFIDENCE}, if it was a car trip, or if you already reached today's cap of ${C.DAILY_POINTS_CAP} points.`,
  },
  {
    id: 'points-car',
    questions: ['do car trips earn points', 'can i log a car trip', 'what happens if i drive', 'should i log driving'],
    answer: `You can log car trips, but they earn ${r.car} points and lower your eco score a little, by about ${C.ECO_PENALTY_PER_CAR_KM} per km. Logging them honestly keeps your record real.`,
  },
  {
    id: 'points-trust',
    questions: ['what is the trust multiplier', 'what is trust', 'why is my trust low', 'how does trust work', 'how do i raise my trust'],
    answer: `Trust multiplies your trip points. It drops by ${C.TRUST_DROP} after a trip scored below ${C.LOW_CONFIDENCE} confidence, and recovers by ${C.TRUST_RECOVERY} with each clean trip, up to 1.`,
  },
  {
    id: 'points-confidence',
    questions: ['what is confidence', 'what does trip confidence mean', 'how is confidence calculated', 'what lowers confidence'],
    answer: `Confidence, from 0 to 1, is how sure we are a trip is real. It drops for things like speeds too high for your mode, GPS jumps, poor accuracy or very constant speed.`,
  },
  {
    id: 'points-more',
    questions: ['how can i earn more points', 'tips to get more points', 'fastest way to get points', 'how to maximise points'],
    answer: `Walk when you can, it earns the most at ${r.walk} points per km. Keep the app open in the foreground so GPS records the whole trip, and pick the right mode before you start.`,
  },
  {
    id: 'points-expire',
    questions: ['do points expire', 'will i lose my points', 'how long do points last'],
    answer: `Points don't expire. They stay in your balance until you spend them on a reward.`,
  },
  {
    id: 'points-transfer',
    questions: ['can i give points to a friend', 'can i transfer points', 'share points with someone'],
    answer: `Points can't be transferred, but you can team up with friends in a club and work toward a shared weekly goal.`,
  },

  // --- Eco score ------------------------------------------------------------------
  {
    id: 'eco-what',
    questions: ['what is the eco score', 'how does the eco score work', 'explain eco score', 'what does eco score mean'],
    answer: `Your eco score, from 0 to 100, shows how green your travel is. Car trips lower it, green trips raise it, and some rewards need a minimum eco score.`,
  },
  {
    id: 'eco-car',
    questions: ['how much does a car trip lower my eco score', 'does driving hurt my eco score', 'eco score penalty for car'],
    answer: `A car trip lowers your eco score by ${C.ECO_PENALTY_PER_CAR_KM} per km, at least ${C.ECO_PENALTY_MIN} and at most ${C.ECO_PENALTY_MAX} per trip.`,
  },
  {
    id: 'eco-raise',
    questions: ['how do i raise my eco score', 'how do i increase eco score', 'how to improve eco score', 'eco score go up'],
    answer: `Each green trip of at least ${C.ECO_RECOVERY_MIN_KM} km raises your eco score by ${C.ECO_RECOVERY_PER_TRIP}, up to ${C.ECO_RECOVERY_MAX_PER_DAY} a day, to a maximum of 100.`,
  },
  {
    id: 'eco-dropped',
    questions: ['why did my eco score drop', 'why did my eco score go down', 'eco score decreased'],
    answer: `Eco score only drops for car trips. A suspicious trip with low confidence doesn't count as a car trip, so it never lowers your eco score.`,
  },
  {
    id: 'eco-rewards',
    questions: ['why does eco score matter for rewards', 'do rewards need eco score', 'what eco score do i need'],
    answer: `Some rewards need a minimum eco score as well as points. Below it the reward stays locked even if you have enough points. Each reward shows the score it needs.`,
  },

  // --- Rewards --------------------------------------------------------------------
  {
    id: 'rewards-locked',
    questions: ['why is a reward locked', 'why are rewards locked', 'what does locked mean', 'reward says locked', 'how do i unlock a reward'],
    answer: `A reward is locked when your eco score is below the score it needs, even if you have enough points. Raise your eco score with green trips to unlock it.`,
  },
  {
    id: 'rewards-redeem',
    questions: ['how do i redeem a reward', 'how do i claim a reward', 'how to use my points', 'how do i spend points', 'how to get a reward'],
    answer: `Open Rewards, pick one that is unlocked and affordable, and tap Redeem. The points come off your balance and you get a code to show at the merchant.`,
  },
  {
    id: 'rewards-twice',
    questions: ['can i redeem the same reward twice', 'redeem a reward again', 'why cant i redeem again', 'already redeemed today'],
    answer: `Each reward can be redeemed ${R.REDEMPTIONS_PER_REWARD_PER_DAY === 1 ? 'once' : `${R.REDEMPTIONS_PER_REWARD_PER_DAY} times`} per day. Come back tomorrow to redeem it again.`,
  },
  {
    id: 'rewards-code',
    questions: ['where is my redemption code', 'where do i find my code', 'lost my reward code', 'show my redeemed rewards'],
    answer: `Your codes are in Rewards under your redeemed rewards, newest first. Show the code at the merchant.`,
  },
  {
    id: 'rewards-real',
    questions: ['are the rewards real', 'is this a real tim hortons deal', 'are the merchants real', 'are these real businesses'],
    answer: `Not yet. Commutr is a hackathon demo, so every merchant, reward and code is demo data. No real business or sponsor is involved.`,
  },
  {
    id: 'rewards-giftcard',
    questions: ['what are gift cards', 'how do gift cards work', 'can i get a gift card'],
    answer: `Gift cards are rewards you can redeem from anywhere, no visit needed. Like other rewards they cost points and some need a minimum eco score.`,
  },
  {
    id: 'rewards-afford',
    questions: ['what is the difference between locked and not affordable', 'not enough points for reward', 'reward too expensive'],
    answer: `Locked means your eco score is too low. Not affordable means you need more points. Each reward shows how many more points or eco score you need.`,
  },
  {
    id: 'rewards-refund',
    questions: ['can i get my points back', 'refund a reward', 'undo a redemption', 'cancel a reward'],
    answer: `Redemptions can't be undone, so double check before you tap Redeem.`,
  },
  {
    id: 'rewards-new',
    questions: ['will there be more rewards', 'how often are rewards added', 'new rewards'],
    answer: `The rewards in this demo are fixed for now. More local spots could be added later.`,
  },

  // --- Streaks --------------------------------------------------------------------
  {
    id: 'streak-what',
    questions: ['what is a streak', 'how do streaks work', 'explain streaks', 'what does streak mean'],
    answer: `Your streak counts the days in a row you made a green trip. A day counts with one finished non-car trip of at least ${C.STREAK_MIN_KM} km and confidence of ${C.LOW_CONFIDENCE} or more.`,
  },
  {
    id: 'streak-keep',
    questions: ['how do i keep my streak', 'how not to lose my streak', 'keep streak going'],
    answer: `Make one green trip of at least ${C.STREAK_MIN_KM} km every day, Toronto time. A short walk counts.`,
  },
  {
    id: 'streak-lost',
    questions: ['why did i lose my streak', 'my streak reset', 'streak went to zero', 'why is my streak 0'],
    answer: `A streak resets when a whole day passes without a qualifying green trip. Your longest streak is always kept.`,
  },
  {
    id: 'streak-car',
    questions: ['does a car trip break my streak', 'will driving end my streak'],
    answer: `No. Car trips never break a streak. Only a missed day does.`,
  },

  // --- Clubs ----------------------------------------------------------------------
  {
    id: 'clubs-what',
    questions: ['what are clubs', 'how do clubs work', 'explain clubs', 'what is a club'],
    answer: `Clubs are groups with a shared weekly step goal. Every member's walking adds up, and reaching the goal earns a group reward.`,
  },
  {
    id: 'clubs-join',
    questions: ['how do i join a club', 'join a club', 'how to leave a club', 'can i leave a club'],
    answer: `Open Clubs, pick one and tap Join. You can leave any time. Leaving removes your steps from that club's weekly total.`,
  },
  {
    id: 'clubs-steps',
    questions: ['how are club steps counted', 'how do steps work', 'do bike trips count for steps', 'what counts toward the club goal'],
    answer: `Only walking counts toward club goals: each verified walking km adds ${C.STEPS_PER_WALK_KM} steps, from trips with confidence of ${C.LOW_CONFIDENCE} or more.`,
  },
  {
    id: 'clubs-reset',
    questions: ['when do club steps reset', 'does the weekly goal reset', 'when does the club week start'],
    answer: `Club totals reset every Monday, Toronto time. New members start at zero for the week.`,
  },
  {
    id: 'clubs-reward',
    questions: ['what is the group reward', 'how do we get the club reward', 'club goal reached what happens'],
    answer: `Each club shows its group reward. When the weekly total reaches the goal, the club is marked as goal reached. Claiming the reward isn't built yet in this demo.`,
  },
  {
    id: 'clubs-many',
    questions: ['can i join more than one club', 'how many clubs can i join'],
    answer: `Yes, you can join as many clubs as you like. Your walking counts toward all of them.`,
  },

  // --- Trips ----------------------------------------------------------------------
  {
    id: 'trip-start',
    questions: ['how do i start a trip', 'how do i track a trip', 'how to record a trip', 'start tracking'],
    answer: `Pick your mode, walk, bike, scooter, transit or car, then tap Start. Keep the app open while you travel and tap Finish when you arrive.`,
  },
  {
    id: 'trip-mode-first',
    questions: ['why do i pick the mode first', 'why choose mode before trip', 'can i change mode after'],
    answer: `Each mode has its own speed checks and points rate, so you pick it before the trip starts. The mode can't change during a trip.`,
  },
  {
    id: 'trip-background',
    questions: ['does tracking work in the background', 'why did gps stop when screen was off', 'phone locked during trip', 'tracking stopped'],
    answer: `Browsers pause GPS when the screen is off or the app is in the background, so keep Commutr open. Gaps alone don't lower your score.`,
  },
  {
    id: 'trip-gaps',
    questions: ['do gps gaps hurt my score', 'what if gps drops out', 'missing gps points'],
    answer: `Gaps in GPS points don't reduce confidence by themselves. They only count if your position jumps impossibly far during the gap.`,
  },
  {
    id: 'trip-forgot',
    questions: ['i forgot to finish my trip', 'what if i forget to end a trip', 'trip still running', 'cant start new trip'],
    answer: `Only one trip can be active at a time. Open the active trip and tap Finish, then you can start a new one.`,
  },
  {
    id: 'trip-transit',
    questions: ['how do transit trips work', 'how to log a bus trip', 'why did my bus trip get flagged', 'transit trip low points'],
    answer: `Transit trips need to start and end within ${C.STOP_RADIUS_M} metres of a GRT stop. Start tracking at the stop and finish when you get off.`,
  },
  {
    id: 'trip-scooter',
    questions: ['do scooters count', 'can i log an e scooter', 'shared scooter trip'],
    answer: `Yes. Scooter trips earn ${r.scooter} points per km. Pick scooter as the mode before you start.`,
  },
  {
    id: 'trip-mixed',
    questions: ['what if i walk then take the bus', 'mixed mode trip', 'bike and bus in one trip', 'multiple modes one trip'],
    answer: `Log each part as its own trip: finish the walk, then start a transit trip at the stop. Each part gets the right rate.`,
  },
  {
    id: 'trip-history',
    questions: ['where are my past trips', 'see my trip history', 'show my trips'],
    answer: `Your trips are listed newest first. Open one to see its route on the map, its distance, confidence and points.`,
  },
  {
    id: 'trip-distance',
    questions: ['why is my distance shorter', 'trip distance wrong', 'how is distance measured'],
    answer: `Distance only counts verified parts of your route. GPS points worse than ${C.MAX_ACCURACY_M} metres accuracy are dropped, and impossible jumps don't count.`,
  },
  {
    id: 'trip-accuracy',
    questions: ['how do i improve gps accuracy', 'gps is inaccurate', 'poor accuracy warning'],
    answer: `Allow precise location, keep the app open, and avoid starting indoors. Tall buildings can reduce accuracy too.`,
  },

  // --- Anti-cheat -----------------------------------------------------------------
  {
    id: 'flag-speed',
    questions: ['what does speed too high mean', 'why was my trip flagged for speed', 'speed flag'],
    answer: `The trip's average speed was too high for the mode you picked, for example walking faster than ${C.SPEED_LIMITS.walk.avgMaxKmh} km per hour.`,
  },
  {
    id: 'flag-car-burst',
    questions: ['what is a car like burst', 'why does it say car like', 'flagged as car while biking'],
    answer: `For a minute or more you went at car speed, over ${C.SPEED_LIMITS.walk.carBurstKmh} km per hour on a walk or ${C.SPEED_LIMITS.bike.carBurstKmh} on a bike. That part doesn't count toward your distance.`,
  },
  {
    id: 'flag-jump',
    questions: ['what is an impossible jump', 'why does it say gps jump', 'teleport flag'],
    answer: `Your position moved ${C.JUMP_MIN_DISTANCE_M} metres or more faster than your mode allows, which usually means a GPS glitch. The jump doesn't count toward distance.`,
  },
  {
    id: 'flag-constant',
    questions: ['what does constant speed mean', 'why was my trip too steady', 'robotic speed flag'],
    answer: `Real trips speed up and slow down. A speed that barely changes looks automated, so confidence drops.`,
  },
  {
    id: 'flag-far',
    questions: ['what does far from last trip mean', 'why flagged far from last trip'],
    answer: `The trip started more than ${C.FAR_START_KM} km from where your last trip ended, less than ${C.FAR_START_WINDOW_MIN} minutes later. That's hard to do without a car.`,
  },
  {
    id: 'flag-appeal',
    questions: ['my trip was flagged by mistake', 'can i appeal a flag', 'unfair flag'],
    answer: `Sorry about that. Flags only lower one trip's confidence, and trust recovers with clean trips. Keeping the app open with precise location helps avoid false flags.`,
  },
  {
    id: 'flag-cheat',
    questions: ['can i cheat', 'how do people cheat', 'can i fake trips'],
    answer: `Trips are checked for car speeds, GPS jumps and robotic patterns. Suspicious trips earn nothing and lower your trust, so honest trips pay best.`,
  },

  // --- Transit and getting around KW ----------------------------------------------
  {
    id: 'bus-live',
    questions: ['how do live buses work', 'where are the buses', 'show live bus locations', 'is the bus map live'],
    answer: `The map shows live GRT bus and ION train positions from GRT's open data, updated every few seconds.`,
  },
  {
    id: 'bus-simulated',
    questions: ['why does it say simulated', 'buses are simulated', 'are these real buses'],
    answer: `When GRT's live feed is down or not running, like late at night, the map shows simulated buses on real routes and labels them simulated.`,
  },
  {
    id: 'bus-ion',
    questions: ['what is the ion', 'does the ion count as transit', 'light rail trip'],
    answer: `ION is the Region of Waterloo's light rail. ION trips count as transit, at ${r.transit} points per km.`,
  },
  {
    id: 'bus-fares',
    questions: ['how much is a bus fare', 'grt fare price', 'how do i pay for the bus', 'bus ticket cost'],
    answer: `For current fares and how to pay, check grt.ca. Commutr doesn't sell tickets.`,
  },
  {
    id: 'bus-schedule',
    questions: ['when is the next bus', 'bus schedule', 'grt timetable', 'when does the bus come'],
    answer: `The map shows where buses are right now. For schedules and trip planning, check grt.ca.`,
  },
  {
    id: 'bus-stops',
    questions: ['where are the bus stops', 'show stops on map', 'find nearest stop'],
    answer: `GRT bus stops and ION platforms are shown on the map. Zoom in to see the stops near you.`,
  },
  {
    id: 'grt-affiliation',
    questions: ['is commutr part of grt', 'is this a government app', 'are you official', 'is this run by the region'],
    answer: `No. Commutr is an independent hackathon project. It uses GRT's public open data, but isn't affiliated with GRT or any government.`,
  },
  {
    id: 'bus-direction',
    questions: ['why dont buses show direction', 'bus speed missing', 'which way is the bus going'],
    answer: `GRT's live feed doesn't include bus speed or heading, so the map shows each bus's route and destination instead.`,
  },
  {
    id: 'bike-share',
    questions: ['are there shared bikes in kw', 'bike share', 'rent a scooter'],
    answer: `GRT's open data page links shared bike and scooter info. Check grt.ca for what's available near you.`,
  },

  // --- Bike safety ----------------------------------------------------------------
  {
    id: 'bike-safety',
    questions: ['bike safety tips', 'how to bike safely', 'is it safe to bike', 'cycling safety'],
    answer: `Wear a helmet, use lights at night, ride with traffic, and signal your turns. Choose quieter streets and bike lanes when you can.`,
  },
  {
    id: 'bike-ratings',
    questions: ['what is the bike safety rating', 'are bike routes rated', 'safest bike route'],
    answer: `Bike route safety ratings are coming soon. Until then, pick routes with bike lanes or quiet residential streets.`,
  },
  {
    id: 'bike-night',
    questions: ['biking at night', 'is it safe to ride at night', 'night cycling tips'],
    answer: `Use a white front light and a red rear light, wear something bright, and stick to well lit streets.`,
  },
  {
    id: 'bike-winter',
    questions: ['biking in winter', 'cycling in snow', 'is it ok to bike in winter'],
    answer: `Go slower, brake early, watch for ice, and dress in layers. Walking or transit are great options on icy days.`,
  },
  {
    id: 'walk-safety',
    questions: ['walking safety tips', 'is it safe to walk at night', 'walking at night'],
    answer: `Use crosswalks, make eye contact with drivers, and wear something bright after dark. Busy, well lit streets are best at night.`,
  },

  // --- App and account ------------------------------------------------------------
  {
    id: 'app-what',
    questions: ['what is commutr', 'what does this app do', 'how does commutr work', 'tell me about commutr'],
    answer: `Commutr rewards you for walking, biking and taking transit around Kitchener-Waterloo instead of driving. Trips earn points you can spend at local spots.`,
  },
  {
    id: 'app-free',
    questions: ['is commutr free', 'does it cost money', 'do i have to pay'],
    answer: `Yes, Commutr is free to use.`,
  },
  {
    id: 'app-privacy',
    questions: ['is my location private', 'what do you do with my location', 'privacy', 'who sees my gps data'],
    answer: `Your GPS points are only used to check and score your trips. This chat assistant never sees your name, email or location.`,
  },
  {
    id: 'app-install',
    questions: ['how do i install the app', 'add to home screen', 'is there an app store app'],
    answer: `Commutr is a web app. Open it in your phone's browser and choose Add to Home Screen to install it.`,
  },
  {
    id: 'app-battery',
    questions: ['does tracking drain battery', 'battery usage', 'gps uses battery'],
    answer: `GPS does use some battery. Tracking only runs while a trip is active, so finish your trip when you arrive.`,
  },
  {
    id: 'locations-home',
    questions: ['how do i save my home', 'set home location', 'change my home address'],
    answer: `Open Saved places and add a home. You can have one home, and adding a new one replaces the old.`,
  },
  {
    id: 'locations-fav',
    questions: ['how do i save a favourite place', 'add a favourite location', 'how many favourites can i save'],
    answer: `Open Saved places and add a favourite. You can save up to ${R.MAX_FAVOURITES} favourites.`,
  },
  {
    id: 'app-demo',
    questions: ['is this a demo', 'is the data real', 'are other users real'],
    answer: `This is a hackathon demo. Live buses and stops are real GRT data, but users, merchants, rewards and clubs are demo data.`,
  },
  {
    id: 'app-who',
    questions: ['who made commutr', 'who built this', 'who are you'],
    answer: `I'm the Commutr mascot. Commutr was built at a hackathon to make getting around Kitchener-Waterloo greener and more fun.`,
  },
  {
    id: 'chat-voice',
    questions: ['can i talk to you', 'how does voice chat work', 'can i use my voice'],
    answer: `Yes. Tap the microphone and ask your question out loud, up to ${MAX_WAV_SECONDS} seconds. I'll answer in text and voice.`,
  },
  {
    id: 'chat-help',
    questions: ['what can you do', 'what can i ask you', 'help', 'what do you know'],
    answer: `Ask me about points, rewards, your eco score, streaks, clubs, trips or live buses. I can also suggest a place to eat that you can afford.`,
  },
  {
    id: 'greeting',
    questions: ['hi', 'hello', 'hey', 'good morning', 'hey there'],
    answer: `Hi! I'm the Commutr mascot. Ask me about points, rewards or getting around Kitchener-Waterloo.`,
  },
  {
    id: 'thanks',
    questions: ['thanks', 'thank you', 'thank you so much', 'cheers'],
    answer: `You're welcome! Have a great trip.`,
  },
  {
    id: 'weather',
    questions: ['what is the weather', 'will it rain today', 'is it cold outside'],
    answer: `I can't check the weather, but on rainy days the bus and ION are great ways to keep your streak going.`,
  },
  {
    id: 'kw-what',
    questions: ['what is kitchener waterloo', 'what is kw', 'where is commutr available'],
    answer: `Commutr is built for Kitchener-Waterloo in Ontario, including Waterloo, Kitchener and the GRT transit network.`,
  },
  {
    id: 'kw-walkable',
    questions: ['is uptown waterloo walkable', 'good places to walk in kw', 'where can i walk'],
    answer: `Uptown Waterloo, Downtown Kitchener and the trails around Waterloo Park and Victoria Park are great for walking.`,
  },
  {
    id: 'kw-campus',
    questions: ['how do i get to campus', 'getting to uw without a car', 'how to get to laurier'],
    answer: `Walking, biking and the ION all serve the university area. Check grt.ca to plan a transit trip.`,
  },
  {
    id: 'eco-why-green',
    questions: ['why should i walk instead of drive', 'why go green', 'benefits of not driving'],
    answer: `Walking, biking and transit cut emissions and traffic, save money, and keep you active. Commutr rewards every green kilometre.`,
  },
  {
    id: 'points-weekly',
    questions: ['is there a weekly points limit', 'weekly cap'],
    answer: `There's no weekly cap, just the daily cap of ${C.DAILY_POINTS_CAP} points.`,
  },
  {
    id: 'trip-min',
    questions: ['is there a minimum trip length', 'do short trips count', 'how short can a trip be'],
    answer: `Any trip can earn points. For streaks, a trip needs at least ${C.STREAK_MIN_KM} km. For an eco score boost, at least ${C.ECO_RECOVERY_MIN_KM} km.`,
  },
  {
    id: 'trip-run',
    questions: ['does running count', 'can i log a run', 'jogging trip'],
    answer: `Yes, log a run as a walk. Walks can go up to ${C.SPEED_LIMITS.walk.avgMaxKmh} km per hour on average without being flagged.`,
  },
];

/** The 20 answers pre-generated by `npm run chat:warm` by default (most likely questions). */
export const WARM_TOP: string[] = [
  'greeting',
  'chat-help',
  'app-what',
  'points-how',
  'points-rates',
  'points-cap',
  'points-few',
  'eco-what',
  'eco-raise',
  'rewards-locked',
  'rewards-redeem',
  'streak-what',
  'clubs-what',
  'clubs-steps',
  'trip-start',
  'trip-transit',
  'bus-live',
  'bike-safety',
  'app-privacy',
  'thanks',
];
