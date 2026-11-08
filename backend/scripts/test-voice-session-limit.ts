import assert from 'node:assert/strict';
import { takeUserRequest } from '../src/chat/usage.js';

const originalNow = Date.now;
let now = Date.parse('2026-11-08T15:00:00Z');
Date.now = () => now;
try {
  // A shared demo must keep accepting starts beyond the old 30/day ceiling.
  for (let i = 0; i < 1000; i++) {
    if (i > 0 && i % 20 === 0) now += 61_000;
    assert.equal(takeUserRequest('voiceSession', 1).ok, true, `session ${i + 1}`);
    if (i === 19) assert.equal(takeUserRequest('voiceSession', 1).ok, false, 'minute cap retained');
  }
  now += 61_000;
  const daily = takeUserRequest('voiceSession', 1);
  assert.equal(daily.ok, false, 'daily cap retained');
  if (!daily.ok) assert.ok(daily.retryAfterSec > 60);
  for (let i = 0; i < 4; i++) assert.equal(takeUserRequest('voice', 1).ok, true);
  assert.equal(takeUserRequest('voice', 1).ok, false, 'voice uploads retain their separate cap');
  console.log('PASS: shared demo supports 1,000 starts; minute/day caps and separate voice-upload limits remain enforced.');
} finally {
  Date.now = originalNow;
}
