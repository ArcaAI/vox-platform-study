// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// Highlight (doctor-authored W3C quote selectors + free-text note).
//
// Encrypts the populated plaintext columns (exact / prefix / suffix / note) via
// Vault Transit (hope-phi) and writes the ciphertext back. Plaintext columns are
// intentionally left untouched — Phase 6 removes them under a separate
// user-gated SQL change after the dual-read soak. See
// `_phi-encryption-backfill.shared.ts` for the engine, usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-highlight-encryption',
  delegate: 'highlight',
  label: 'Highlight',
  fields: [
    { plaintext: 'exact', ciphertext: 'encryptedExact' },
    { plaintext: 'prefix', ciphertext: 'encryptedPrefix' },
    { plaintext: 'suffix', ciphertext: 'encryptedSuffix' },
    { plaintext: 'note', ciphertext: 'encryptedNote' },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-highlight-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
