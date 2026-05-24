// Phase 2A Task 2.7 (TASK-302 Stream B) - node-vault augmentation.
//
// node-vault 0.10.x ships its own `index.d.ts`, but `unwrap` (which calls
// POST /sys/wrapping/unwrap) is missing from the typed client even though
// it is generated at runtime from `src/commands.js`.
//
// We add the missing method here so VaultSecretsProvider can call it with
// the canonical { token: '<wrap.token>' } shape without an `any` cast.

import 'node-vault';

declare module 'node-vault' {
  namespace NodeVault {
    interface client {
      /**
       * Unwrap a response-wrapped token. Body must contain the wrap token
       * (or, alternatively, the client must be authenticated with the wrap
       * token as its current `token`). Returns the original wrapped data.
       */
      unwrap(options: { token: string } & Option): Promise<{
        data: Record<string, unknown>;
        request_id?: string;
        lease_id?: string;
      }>;
    }
  }
}
