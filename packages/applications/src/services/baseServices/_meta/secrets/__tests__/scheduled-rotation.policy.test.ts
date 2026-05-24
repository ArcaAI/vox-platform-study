// TASK-302 Phase 6 Task 6.6 (Stream B) — Scheduled rotation policy.
import { describe, it, expect } from 'vitest';
import {
  policyDueKeys,
  type RotationPolicy,
} from '../scheduled-rotation.policy';

const policies: RotationPolicy[] = [
  { key: 'API_KEY_PEPPER', maxAgeDays: 180 },
  { key: 'OIDC_CLIENT_SECRET', maxAgeDays: 90 },
  { key: 'JWT_SECRET_KEY', maxAgeDays: 90 },
];

describe('policyDueKeys (Phase 6 Task 6.6)', () => {
  it('returns no keys when all rotations are fresh', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const lastRotated = {
      API_KEY_PEPPER: now - 10 * 86400_000,
      OIDC_CLIENT_SECRET: now - 30 * 86400_000,
      JWT_SECRET_KEY: now - 30 * 86400_000,
    };
    expect(policyDueKeys(now, policies, lastRotated)).toEqual([]);
  });

  it('returns the keys whose last rotation exceeds the policy', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const lastRotated = {
      // 200 days old → due (policy = 180)
      API_KEY_PEPPER: now - 200 * 86400_000,
      // 30 days old → fresh
      OIDC_CLIENT_SECRET: now - 30 * 86400_000,
      // 100 days old → due (policy = 90)
      JWT_SECRET_KEY: now - 100 * 86400_000,
    };
    expect(policyDueKeys(now, policies, lastRotated).sort()).toEqual(
      ['API_KEY_PEPPER', 'JWT_SECRET_KEY'].sort(),
    );
  });

  it('treats missing lastRotated entries as "rotate immediately"', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    // No lastRotated info at all → every policy key is due.
    expect(policyDueKeys(now, policies, {}).sort()).toEqual(
      ['API_KEY_PEPPER', 'OIDC_CLIENT_SECRET', 'JWT_SECRET_KEY'].sort(),
    );
  });

  it('boundary: exactly maxAgeDays old is NOT yet due (strictly older required)', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const lastRotated = {
      API_KEY_PEPPER: now - 180 * 86400_000,
    };
    // The boundary day: rotation happened exactly 180 days ago — give
    // the operator a 24h grace before tripping the policy.
    expect(policyDueKeys(now, [policies[0]], lastRotated)).toEqual([]);
  });

  it('1 ms past the boundary triggers rotation', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const lastRotated = {
      API_KEY_PEPPER: now - 180 * 86400_000 - 1,
    };
    expect(policyDueKeys(now, [policies[0]], lastRotated)).toEqual([
      'API_KEY_PEPPER',
    ]);
  });

  it('ignores keys not present in the policy list', () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const lastRotated = {
      ROGUE_UNTRACKED_KEY: now - 365 * 86400_000,
    };
    expect(
      policyDueKeys(now, [{ key: 'API_KEY_PEPPER', maxAgeDays: 180 }], lastRotated),
    ).toEqual(['API_KEY_PEPPER']); // ROGUE_UNTRACKED_KEY ignored, API_KEY_PEPPER due (no lastRotated)
  });
});
