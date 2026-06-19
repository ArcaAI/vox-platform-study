// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// EvalRun (free-text clinical field: notes).
//
// Encrypts the populated plaintext column via Vault Transit (hope-phi) and
// writes the ciphertext back. Plaintext columns are intentionally left
// untouched — Phase 6 removes them under a separate user-gated SQL change after
// the dual-read soak. See `_phi-encryption-backfill.shared.ts` for the engine,
// usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-evalrun-encryption',
  delegate: 'evalRun',
  label: 'EvalRun',
  fields: [{ plaintext: 'notes', ciphertext: 'encryptedNotes' }],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-evalrun-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
