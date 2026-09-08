/**
 * TASK-893 — cross-language parity for the ACTION catalogue, the same shape as
 * `node-registry-parity.test.ts`: `ACTION_CATALOGUE` (TS) and `action_catalogue.py` (harness)
 * both project onto `fixtures/action-catalogue.snapshot.json`, because neither runtime can
 * import the other's module. Regenerate with `pnpm --filter @arcaai/workflow-contract
 * regen:action-snapshot`, then make the Python side agree — a green TS suite proves nothing on
 * its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE } from '../action-catalogue';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/action-catalogue.snapshot.json');

interface FixtureEntry {
  key: string;
  activityName: string;
  critical: boolean;
  externalWrite: boolean;
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
  /** EVERY output port → its runtime key, `null` for a control port (same rule as the registry fixture). */
  outputKeys: Record<string, string | null>;
  lane: 'realtime' | 'durable';
}

function loadFixtureEntries(): FixtureEntry[] {
  return (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { entries: FixtureEntry[] }).entries;
}

export function projectActionCatalogue(): FixtureEntry[] {
  return Object.values(ACTION_CATALOGUE)
    .map((descriptor) => ({
      key: descriptor.key,
      activityName: descriptor.activityName,
      critical: descriptor.critical,
      externalWrite: descriptor.externalWrite,
      defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds,
      defaultMaxAttempts: descriptor.defaultMaxAttempts,
      entitlementKey: descriptor.entitlementKey ?? null,
      outputKeys: Object.fromEntries(descriptor.ports.outputs.map((port) => [port.name, port.outputKey ?? null])),
      lane: descriptor.lane,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('ACTION_CATALOGUE <-> action_catalogue.py parity fixture', () => {
  it('matches the committed cross-language fixture exactly', () => {
    expect(projectActionCatalogue()).toEqual(loadFixtureEntries());
  });

  it('the fixture is sorted by key and carries exactly 17 entries', () => {
    const entries = loadFixtureEntries();
    expect(entries).toHaveLength(17);
    expect(entries).toEqual(entries.slice().sort((a, b) => a.key.localeCompare(b.key)));
  });
});
