// Real-provider checks (spends real quota; NOT part of npm test):
//   chat with tools, speech, Gemini TTS (60 s allowed), voice in, one real plan.
//
//   npm run test:real
//
// Runs both parts even if the first fails. Any failed (or skipped) real step prints
// FAIL and the exit code is non-zero.

import { spawn } from 'node:child_process';
import { BACKEND } from './lib/harness.js';

const run = (script: string) =>
  new Promise<number>((resolve) => {
    const child = spawn('npx', ['tsx', script, '--real'], { cwd: BACKEND, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });

const results: [string, number][] = [];
for (const script of ['scripts/test-chat.ts', 'scripts/test-planner.ts']) results.push([script, await run(script)]);
console.log('\nREAL RUN SUMMARY');
for (const [script, code] of results) console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${script} --real`);
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0);
