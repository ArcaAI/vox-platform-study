/**
 * Round 5 lane F — the ONE repair a create-only phase is allowed to make.
 *
 * THE TRAP. Every platform-configuration phase is CREATE-ONLY, so re-running
 * `pnpm db:seed` against a database that already has rows skips them in silence
 * and exits 0. `setup:dev` force-resets, so it never sees this; anyone running
 * the seed by hand against a live database gets a no-op that looks like success.
 *
 * That was observed for real: four SYSTEM self-hosted connection rows created
 * before the placeholder-key change stayed KEYLESS through a full re-seed, and
 * a keyless row is dropped from the `provider_overrides` fold on BOTH tiers
 * (see the delivery-path header of `17-ai-provider-connection.ts`) — so those
 * four providers silently served nothing. The only fix was deleting the rows.
 *
 * THE DECISION. Create-only STAYS for everything an administrator can own — an
 * endpoint, an enable/disable state, a vendor credential, a model selection. A
 * re-seed must never clobber those, and that is why this phase is create-only in
 * the first place. What is added is a strictly narrower repair, matching the
 * field-level reconcile `06-stt.ts` already performs on catalog columns:
 *
 *   backfill the NON-SECRET self-host placeholder onto a row that has NO key.
 *
 * It cannot destroy anything, because it only writes where nothing is written:
 * the target is `encryptedApiKey === null`, the value is the constant
 * `'not-needed'` rather than a credential, and it is confined to connections the
 * PLATFORM itself runs. A keyless self-host row is not a configuration choice an
 * admin could have made — it is a non-functional row, since keyless rows never
 * reach the consumer.
 */
import { describe, expect, it } from 'vitest';

import { SELF_HOST_PLACEHOLDER_API_KEY, SYSTEM_AI_PROVIDER_CONNECTIONS, needsSelfHostKeyBackfill } from '../17-ai-provider-connection';

const selfHostRow = { service: 'llm', provider: 'lm-studio', apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY };
const cloudRow = { service: 'llm', provider: 'azure', apiKeyPlaintext: null };

describe('self-host placeholder-key backfill', () => {
  it('repairs a self-host row that carries no key at all', () => {
    expect(needsSelfHostKeyBackfill(selfHostRow, { encryptedApiKey: null })).toBe(true);
  });

  it('never touches a row that already has key material', () => {
    expect(needsSelfHostKeyBackfill(selfHostRow, { encryptedApiKey: Uint8Array.from([1, 2, 3]) })).toBe(false);
  });

  it('never writes a key the seed does not carry — a cloud row stays keyless', () => {
    // Cloud/BYO rows are keyless ON PURPOSE: the key is the tenant's to supply.
    expect(needsSelfHostKeyBackfill(cloudRow, { encryptedApiKey: null })).toBe(false);
  });

  it('treats a zero-length key as absent, not as a credential', () => {
    expect(needsSelfHostKeyBackfill(selfHostRow, { encryptedApiKey: new Uint8Array(0) })).toBe(true);
  });

  it('the seed only ever carries the non-secret placeholder as plaintext key material', () => {
    // The safety property the backfill rests on: nothing in this seed can write
    // a real credential, so a backfill can never leak or overwrite one.
    const plaintexts = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => c.apiKeyPlaintext).filter((v): v is string => v !== null);
    expect(plaintexts.length).toBeGreaterThan(0);
    expect([...new Set(plaintexts)]).toEqual([SELF_HOST_PLACEHOLDER_API_KEY]);
  });
});
