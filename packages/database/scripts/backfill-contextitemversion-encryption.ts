// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// ContextItemVersion (immutable content snapshots: content / contentDiff /
// changeSummary / fieldChanges JSONB).
//
// Encrypts the populated plaintext columns via Vault Transit (hope-phi) and
// writes the ciphertext back. Plaintext columns are intentionally left
// untouched — Phase 6 removes them under a separate user-gated SQL change after
// the dual-read soak. See `_phi-encryption-backfill.shared.ts` for the engine,
// usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-contextitemversion-encryption',
  delegate: 'contextItemVersion',
  label: 'ContextItemVersion',
  fields: [
    { plaintext: 'content', ciphertext: 'encryptedContent' },
    { plaintext: 'contentDiff', ciphertext: 'encryptedContentDiff' },
    { plaintext: 'changeSummary', ciphertext: 'encryptedChangeSummary' },
    { plaintext: 'fieldChanges', ciphertext: 'encryptedFieldChanges', json: true },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-contextitemversion-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
