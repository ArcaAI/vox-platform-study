// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// TranscriptionJob (STT result: resultText free-text + resultMetadata JSONB).
//
// Encrypts the populated plaintext columns via Vault Transit (hope-phi) and
// writes the ciphertext back. Plaintext columns are intentionally left
// untouched — Phase 6 removes them under a separate user-gated SQL change after
// the dual-read soak. See `_phi-encryption-backfill.shared.ts` for the engine,
// usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-transcriptionjob-encryption',
  delegate: 'transcriptionJob',
  label: 'TranscriptionJob',
  fields: [
    { plaintext: 'resultText', ciphertext: 'encryptedResultText' },
    { plaintext: 'resultMetadata', ciphertext: 'encryptedResultMetadata', json: true },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-transcriptionjob-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
