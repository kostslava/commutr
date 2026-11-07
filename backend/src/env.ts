// Loads backend/.env into process.env (Node's built-in loader, no package).
// Import this FIRST in entry points: other modules read process.env when they load.
//
// COMMUTR_ENV_FILE=none skips it (the test scripts use this so mocked tests never
// see real keys). Variables already set in the environment win over the file.
// Never log values from here.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const setting = process.env.COMMUTR_ENV_FILE;
const path = setting && setting !== 'none' ? setting : fileURLToPath(new URL('../.env', import.meta.url));

if (setting !== 'none' && existsSync(path)) {
  process.loadEnvFile(path);
}
