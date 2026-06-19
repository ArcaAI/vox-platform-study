// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// NamedEntity (recognized free-text span text / normalizedText + metadata JSONB).
//
// Encrypts the populated plaintext columns via Vault Transit (hope-phi) and
// writes the ciphertext back. The short ontology code columns (umlsCui /
// snomedCode / rxnormCode / icdCode / loincCode) are intentionally NOT encrypted
// (kept queryable under disk encryption, per the data-classification decision).
// Plaintext columns are intentionally left untouched — Phase 6 removes them
// under a separate user-gated SQL change after the dual-read soak. See
// `_phi-encryption-backfill.shared.ts` for the engine, usage, and exit codes.
//
// Volume note: NamedEntity rows are created in BULK by the NER pipeline; for a
// large backfill prefer a bounded --batch-size and run off-peak.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-namedentity-encryption',
  delegate: 'namedEntity',
  label: 'NamedEntity',
  fields: [
    { plaintext: 'text', ciphertext: 'encryptedText' },
    { plaintext: 'normalizedText', ciphertext: 'encryptedNormalizedText' },
    { plaintext: 'metadata', ciphertext: 'encryptedMetadata', json: true },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-namedentity-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
