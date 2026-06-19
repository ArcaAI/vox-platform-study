// TASK-369 (Data Encryption Initiative) Phase 3C — backfill encryption for
// Notification (message body that may carry PHI hints).
//
// Encrypts the populated plaintext columns (messageText / messageRichText /
// messageContent JSONB) via Vault Transit (hope-phi) and writes the ciphertext
// back. Plaintext columns are intentionally left untouched — Phase 6 removes
// them under a separate user-gated SQL change after the dual-read soak. See
// `_phi-encryption-backfill.shared.ts` for the engine, usage, and exit codes.

import { type BackfillConfig, runMainAsCli } from './_phi-encryption-backfill.shared.js';

export const config: BackfillConfig = {
  scriptName: 'backfill-notification-encryption',
  delegate: 'notification',
  label: 'Notification',
  fields: [
    { plaintext: 'messageText', ciphertext: 'encryptedMessageText' },
    { plaintext: 'messageRichText', ciphertext: 'encryptedMessageRichText' },
    { plaintext: 'messageContent', ciphertext: 'encryptedMessageContent', json: true },
  ],
};

const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-notification-encryption/.test(process.argv[1]);
if (invokedDirectly) runMainAsCli(config);
