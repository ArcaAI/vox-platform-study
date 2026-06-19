// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// SummaryMeta (citation provenance + guardrail decision JSONB blobs, which can
// echo clinical content / transcript spans).
//
// Encrypts the populated plaintext columns via Vault Transit (hope-phi) and
// writes the ciphertext back. Plaintext columns are intentionally left
// untouched — Phase 6 removes them under a separate user-gated SQL change after
// the dual-read soak. See `_phi-encryption-backfill.shared.ts` for the engine,
// usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-summarymeta-encryption',
  delegate: 'summaryMeta',
  label: 'SummaryMeta',
  fields: [
    { plaintext: 'citationsMap', ciphertext: 'encryptedCitationsMap', json: true },
    { plaintext: 'guardrailDecisions', ciphertext: 'encryptedGuardrailDecisions', json: true },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-summarymeta-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
