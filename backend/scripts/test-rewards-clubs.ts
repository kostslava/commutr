// Rewards, clubs, /me and saved locations, through the REAL endpoints.
//
//   npm run test:rewards
//
// Uses the shared harness: a throwaway seeded DB (backend/data/test-rewards.db)
// and its own server on port 8798. Each case uses its own fresh test user.

import { addDays, torontoDate, torontoWeekStart } from '../src/time.js';
import { LAURIER, phone, UPTOWN, UW, walking } from './lib/gps.js';
import { addUser, runTrip, startHarness, table } from './lib/harness.js';

type Row = { Case: string; Check: string; Result: string };
const rows: Row[] = [];
let failures = 0;
function check(caseName: string, label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  rows.push({ Case: caseName, Check: label + (detail ? ` (${detail})` : ''), Result: ok ? 'PASS' : 'FAIL' });
}

const CODE_RE = /^CMTR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

async function main() {
  const h = await startHarness({ dbName: 'test-rewards.db', port: 8798 });
  const { api, db } = h;
  const points = (uid: number) => (db.prepare('SELECT points FROM users WHERE id = ?').get(uid) as { points: number }).points;
  const today = torontoDate();
  const thisWeek = torontoWeekStart();
  const lastWeek = addDays(thisWeek, -7);

  try {
    // ------------------------------------------------------------------ rewards
    // Seed rewards: 1 = $5 card (500 pts, eco 80), 2 = $10 (1000, 85), 3 = $25 (2500, 95)
    let c = 'Redeem success';
    addUser(db, 201, c, { points: 1200, eco_score: 90 });
    let r = await api(201, 'POST', '/api/rewards/2/redeem', {});
    check(c, 'redeem $10 card -> 201', r.status === 201, `HTTP ${r.status}`);
    const code = r.json?.redemption?.code as string;
    check(c, 'code looks like CMTR-XXXX-XXXX', CODE_RE.test(code ?? ''), code);
    check(c, 'points 1200 -> 200', points(201) === 200 && r.json.user.points === 200, `now ${points(201)}`);
    const reds = (await api(201, 'GET', '/api/redemptions')).json.redemptions;
    check(c, 'shows in GET /api/redemptions', reds.length === 1 && reds[0].code === code && reds[0].title === '$10 Maple Loop Coffee card', `${reds.length} row(s)`);
    const after = (await api(201, 'GET', '/api/rewards')).json.rewards.find((x: any) => x.id === 2);
    check(c, 'reward list marks redeemed_today', after.redeemed_today === true);

    c = 'Locked by eco score';
    addUser(db, 202, c, { points: 5000, eco_score: 82 });
    const locked = (await api(202, 'GET', '/api/rewards')).json.rewards.find((x: any) => x.id === 3);
    check(c, 'list: locked, affordable, lock_reason', locked.locked === true && locked.affordable === true && locked.lock_reason === 'eco_score_too_low', `eco_needed ${locked.eco_needed}`);
    r = await api(202, 'POST', '/api/rewards/3/redeem', {});
    check(c, 'redeem $25 (needs eco 95) -> 403 eco_score_too_low', r.status === 403 && r.json.error.code === 'eco_score_too_low' && r.json.min_eco_score === 95, `HTTP ${r.status}`);
    check(c, 'points unchanged (5000)', points(202) === 5000);

    c = 'Not enough points';
    addUser(db, 203, c, { points: 300, eco_score: 98 });
    const poor = (await api(203, 'GET', '/api/rewards')).json.rewards.find((x: any) => x.id === 1);
    check(c, 'list: unlocked, lock_reason not_enough_points', poor.locked === false && poor.affordable === false && poor.lock_reason === 'not_enough_points' && poor.points_needed === 200, `points_needed ${poor.points_needed}`);
    r = await api(203, 'POST', '/api/rewards/1/redeem', {});
    check(c, 'redeem $5 (500 pts) with 300 -> 409 not_enough_points', r.status === 409 && r.json.error.code === 'not_enough_points', `HTTP ${r.status}`);
    check(c, 'points unchanged (300)', points(203) === 300);

    c = 'Double redeem';
    addUser(db, 204, c, { points: 2000, eco_score: 98 });
    const first = await api(204, 'POST', '/api/rewards/1/redeem', {});
    const second = await api(204, 'POST', '/api/rewards/1/redeem', {});
    check(c, 'first -> 201', first.status === 201);
    check(c, 'second same day -> 409 already_redeemed_today', second.status === 409 && second.json.error.code === 'already_redeemed_today', `HTTP ${second.status}`);
    check(c, 'charged once: 2000 -> 1500', points(204) === 1500, `now ${points(204)}`);
    check(c, 'one redemption row', (await api(204, 'GET', '/api/redemptions')).json.redemptions.length === 1);

    c = 'Unknown reward';
    r = await api(201, 'POST', '/api/rewards/999/redeem', {});
    check(c, 'reward 999 -> 404 not_found', r.status === 404 && r.json.error.code === 'not_found', `HTTP ${r.status}`);

    // ------------------------------------------------------------------ clubs
    c = 'Join and leave';
    addUser(db, 209, c);
    const before = (await api(209, 'GET', '/api/clubs/2')).json;
    r = await api(209, 'POST', '/api/clubs/2/join', {});
    check(c, 'join -> member_count +1, is_member', r.status === 200 && r.json.club.member_count === before.member_count + 1 && r.json.club.is_member, `${before.member_count} -> ${r.json.club.member_count}`);
    r = await api(209, 'POST', '/api/clubs/2/join', {});
    check(c, 'join again is a no-op', r.status === 200 && r.json.club.member_count === before.member_count + 1);
    db.prepare('UPDATE club_members SET steps_this_week = 5000 WHERE club_id = 2 AND user_id = 209').run();
    const mid = (await api(209, 'GET', '/api/clubs/2')).json;
    check(c, 'my 5000 steps count toward the club', mid.steps_this_week === before.steps_this_week + 5000, `${before.steps_this_week} -> ${mid.steps_this_week}`);
    r = await api(209, 'POST', '/api/clubs/2/leave', {});
    check(c, 'leave -> count and total back', r.json.club.member_count === before.member_count && r.json.club.steps_this_week === before.steps_this_week && !r.json.club.is_member);
    r = await api(209, 'POST', '/api/clubs/2/leave', {});
    check(c, 'leave again -> 200', r.status === 200 && r.json.left === true);
    r = await api(209, 'POST', '/api/clubs/999/join', {});
    check(c, 'join unknown club -> 404', r.status === 404);

    c = 'Weekly reset';
    addUser(db, 210, c);
    const club1 = (await api(210, 'GET', '/api/clubs/1')).json;
    db.prepare('INSERT INTO club_members (club_id, user_id, joined_at, steps_this_week, week_start) VALUES (1, 210, ?, 9999, ?)').run(new Date().toISOString(), lastWeek);
    const club1b = (await api(210, 'GET', '/api/clubs/1')).json;
    check(c, "last week's 9999 steps don't count (read)", club1b.steps_this_week === club1.steps_this_week && club1b.members.find((m: any) => m.user_id === 210)?.steps_this_week === 0, `total ${club1.steps_this_week} -> ${club1b.steps_this_week}`);
    const me210 = (await api(210, 'GET', '/api/me')).json;
    check(c, '/me shows my_steps_this_week 0', me210.clubs.find((x: any) => x.id === 1)?.my_steps_this_week === 0);
    const walk = await runTrip(api, 210, 'walk', 1, [{ path: [UW, LAURIER, UPTOWN], speed: walking(), ...phone }]);
    const row = db.prepare('SELECT steps_this_week, week_start FROM club_members WHERE club_id = 1 AND user_id = 210').get() as { steps_this_week: number; week_start: string };
    check(c, 'a walk this week resets to just the new steps (write)', row.steps_this_week === walk.steps_added && row.week_start === thisWeek, `${walk.steps_added} steps, not ${9999 + walk.steps_added}`);
    const club1c = (await api(210, 'GET', '/api/clubs/1')).json;
    check(c, 'club total = before + new steps', club1c.steps_this_week === club1.steps_this_week + walk.steps_added);

    // ------------------------------------------------------------------ streak
    c = 'Stale streak';
    const streakCases: [number, string, number, number, boolean][] = [
      // uid, last active, stored current, expected shown, active_today
      [211, addDays(today, -3), 5, 0, false],
      [212, addDays(today, -1), 4, 4, false],
      [213, today, 2, 2, true],
    ];
    for (const [uid, last, stored, shown, activeToday] of streakCases) {
      addUser(db, uid, `${c} ${last}`);
      db.prepare('INSERT INTO streaks (user_id, current_days, longest_days, last_active_date) VALUES (?, ?, 8, ?)').run(uid, stored, last);
      const s = (await api(uid, 'GET', '/api/me')).json.streak;
      const label = last === today ? 'today' : last === addDays(today, -1) ? 'yesterday' : '3 days ago';
      check(c, `last active ${label}: stored ${stored} -> shown ${shown}, longest kept`, s.current_days === shown && s.longest_days === 8 && s.active_today === activeToday, JSON.stringify(s));
    }
    const stored211 = db.prepare('SELECT current_days FROM streaks WHERE user_id = 211').get() as { current_days: number };
    check(c, 'stored row not modified by reading', stored211.current_days === 5);

    // ------------------------------------------------------------------ /me
    c = '/me fields';
    const me = (await api(201, 'GET', '/api/me')).json;
    check(
      c,
      'points, eco, trust, points_today, daily_cap, clubs, locations',
      me.points === 200 && me.eco_score === 90 && me.trust_multiplier === 1 && me.points_today === 0 && me.daily_cap === 200 && Array.isArray(me.clubs) && Array.isArray(me.saved_locations),
    );
    const seed1 = (await api(1, 'GET', '/api/me')).json;
    const seed2 = (await api(2, 'GET', '/api/me')).json;
    check(c, 'seed (relative dates): user 1 streak alive, user 2 stale', seed1.streak.current_days === 5 && seed2.streak.current_days === 0, `${seed1.streak.current_days} / ${seed2.streak.current_days}`);
    check(c, "seed: user 1's clubs show this week's steps", seed1.clubs[0]?.steps_this_week > 0, `${seed1.clubs[0]?.steps_this_week} steps`);

    // ------------------------------------------------------------------ locations
    c = 'Saved locations';
    addUser(db, 214, c);
    const home1 = await api(214, 'POST', '/api/locations', { kind: 'home', label: 'Home', lat: 43.47, lng: -80.54 });
    check(c, 'add home -> 201', home1.status === 201 && home1.json.replaced_id === null);
    const fav = await api(214, 'POST', '/api/locations', { kind: 'favourite', label: 'Gym', lat: 43.46, lng: -80.52 });
    check(c, 'add favourite -> 201', fav.status === 201);
    const home2 = await api(214, 'POST', '/api/locations', { kind: 'home', label: 'New home', lat: 43.45, lng: -80.5 });
    check(c, 'second home replaces the first', home2.status === 201 && home2.json.replaced_id === home1.json.location.id);
    const list = (await api(214, 'GET', '/api/locations')).json.locations;
    check(c, 'list: 1 home (first) + 1 favourite', list.length === 2 && list[0].kind === 'home' && list[0].label === 'New home' && list[1].label === 'Gym');
    r = await api(214, 'DELETE', `/api/locations/${fav.json.location.id}`);
    check(c, 'delete favourite -> 204', r.status === 204);
    r = await api(214, 'DELETE', '/api/locations/1'); // seed user 1's home
    check(c, "delete someone else's location -> 404", r.status === 404);
    r = await api(214, 'POST', '/api/locations', { kind: 'work', label: 'Office', lat: 43.4, lng: -80.5 });
    check(c, 'bad kind -> 400', r.status === 400);
    r = await api(214, 'POST', '/api/locations', { kind: 'favourite', label: 'x'.repeat(51), lat: 43.4, lng: -80.5 });
    check(c, 'label over 50 chars -> 400', r.status === 400);

    console.log('\nREWARDS, CLUBS, ME, LOCATIONS');
    table(rows);
    const health = await fetch(h.base + '/health').then((x) => x.json());
    console.log(`\n${rows.length - failures}/${rows.length} checks passed`);
    console.log(`SERVER: /health -> ${JSON.stringify(health)}, process ${h.serverRunning() ? 'still running' : 'EXITED (bad)'}`);
    if (failures || !h.serverRunning()) process.exitCode = 1;
  } catch (err) {
    console.error('TEST FAILED:', err);
    console.error('--- server log ---\n' + h.serverLog());
    process.exitCode = 1;
  } finally {
    db.close();
    await h.stop();
  }
}

await main();
