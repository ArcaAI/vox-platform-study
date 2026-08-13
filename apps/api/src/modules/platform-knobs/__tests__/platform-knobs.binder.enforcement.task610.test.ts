// The binder is what connects `origin.enforcementEnabled` to the
// pre-bootstrap CORS code, exactly as it already connects `logLevel` to the
// logger: lazily, per call, so a settings write takes effect with no restart.
//
// The failure mode this file exists for is SILENT in both directions. A binder
// that resolved the value ONCE at init would leave the switch permanently stuck
// at whatever the cache held at boot (an operator's write would appear to do
// nothing), and a binder that let a settings error escape would take the switch
// to "enabled" by accident — refusing browser traffic on the strength of an
// exception rather than a resolved value.
//
// Note: enforcement is now the DESCRIPTOR default (`true`), so
// "enabled" is no longer an accident by itself — the accident is arriving there
// via a thrown lookup instead of a read. The lock-out worried about is now
// prevented by the bootstrap migration that guarantees the SYSTEM loopback rows
// (`20260808160000_task_641_bootstrap_loopback_origins`, H-2), not by a
// permissive default. Every case below installs its own fake resolver, so none
// of them observes the descriptor default and none of them changed.
import type { TenantSettingsService } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOriginAllowed, isOriginEnforcementEnabled, setOriginEnforcementResolver, setOriginRegistryResolver } from '../../../cors.config';
import { PlatformKnobsBinder } from '../platform-knobs.binder';

/** Only `resolvePlatform` is exercised; the rest of the service is irrelevant here. */
const fakeSettings = (resolve: (key: string) => unknown): TenantSettingsService =>
  ({
    resolvePlatform: (key: string) => ({ value: resolve(key) }),
  }) as unknown as TenantSettingsService;

describe('PlatformKnobsBinder — origin enforcement resolver', () => {
  beforeEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  it('leaves enforcement OFF when no settings resolver is wired at all', () => {
    new PlatformKnobsBinder().onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
    expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(true);
  });

  it('resolves `origin.enforcementEnabled` from the settings service', () => {
    const keys: string[] = [];
    new PlatformKnobsBinder(
      fakeSettings((key) => {
        keys.push(key);
        return key === 'origin.enforcementEnabled' ? true : 'info';
      }),
    ).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(true);
    expect(keys).toContain('origin.enforcementEnabled');
  });

  // Reworded by : `false` is no longer the descriptor default (
  // made it `true`), so this now pins an OPERATOR-DISABLED platform, not a
  // fresh-database one. The assertion is unchanged — the binder must report
  // whatever the settings service resolves, either way.
  it('keeps enforcement OFF when the setting resolves false — an operator having turned it off', () => {
    new PlatformKnobsBinder(fakeSettings(() => false)).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
  });

  it('re-reads the setting on EVERY call, so a write applies without a restart', () => {
    let enabled = false;
    new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? enabled : 'info'))).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
    enabled = true;
    expect(isOriginEnforcementEnabled()).toBe(true);
  });

  it('stays OFF when the settings lookup throws — never fails INTO enforcement', () => {
    new PlatformKnobsBinder(
      fakeSettings((key) => {
        if (key === 'origin.enforcementEnabled') throw new Error('settings cache exploded');
        return 'info';
      }),
    ).onModuleInit();

    expect(() => isOriginEnforcementEnabled()).not.toThrow();
    expect(isOriginEnforcementEnabled()).toBe(false);
  });
});

/**
 * , Deliverable 4 — WHO gets to state the posture, and WHEN.
 *
 * The first cut of this got it wrong in the most instructive way: `bootstrap()`
 * took a ONE-SHOT reading right after `NestFactory.create()` and printed it. At
 * that instant the AppSettings cache is not warm, so `resolvePlatform` returns
 * the descriptor default — and a gateway with `origin.enforcementEnabled = true`
 * in the database announced "ORIGIN ENFORCEMENT IS DISABLED" at boot and then
 * correctly refused an unregistered origin seconds later.
 *
 * The behaviour was never wrong (the resolver is lazy, so requests always saw
 * the true value); only the announcement was. That is the exact failure this
 * ticket keeps hitting — a signal that LIES about a security posture — and it
 * is worse than silence in both directions: an operator who has enabled
 * enforcement is told the platform is wide open, and a deployment whose default
 * ever flips would be told the opposite.
 *
 * The fix, pinned below: the posture is announced from the ONE place that can
 * observe a trustworthy value — after the settings cache resolves — and it is
 * announced on CHANGE, so it stays truthful for the life of the process instead
 * of being a snapshot that ages badly.
 */
describe('PlatformKnobsBinder — origin enforcement posture logging (Deliverable 4)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** The posture lines only — `warn` also carries the no-settings-wired notice. */
  const postureLines = (): string[] =>
    warnSpy.mock.calls.map(([payload]) => (typeof payload === 'string' ? payload : JSON.stringify(payload))).filter((line) => line.includes('ORIGIN ENFORCEMENT'));

  beforeEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  it('says NOTHING at onModuleInit — the settings cache is not warm yet, and a guess is what caused the defect', () => {
    new PlatformKnobsBinder(fakeSettings(() => true)).onModuleInit();

    expect(postureLines()).toHaveLength(0);
  });

  it('announces the RESOLVED value on the first cache refresh, not the descriptor default', () => {
    const binder = new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? true : 'info')));
    binder.onModuleInit();

    binder.onSettingsRefreshed();

    expect(postureLines()).toHaveLength(1);
    expect(postureLines()[0]).toContain('ENABLED');
    expect(postureLines()[0]).not.toContain('DISABLED');
  });

  it('announces the permissive posture when the value resolves false', () => {
    const binder = new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? false : 'info')));
    binder.onModuleInit();

    binder.onSettingsRefreshed();

    expect(postureLines()).toHaveLength(1);
    expect(postureLines()[0]).toContain('DISABLED');
  });

  it('does NOT re-announce on a refresh that changed nothing', () => {
    const binder = new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? false : 'info')));
    binder.onModuleInit();

    binder.onSettingsRefreshed();
    binder.onSettingsRefreshed();
    binder.onSettingsRefreshed();

    expect(postureLines()).toHaveLength(1);
  });

  it('announces the moment an operator turns enforcement ON — no restart, no polling', () => {
    let enabled = false;
    const binder = new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? enabled : 'info')));
    binder.onModuleInit();
    binder.onSettingsRefreshed();

    enabled = true;
    binder.onSettingsRefreshed();

    const lines = postureLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('DISABLED');
    expect(lines[1]).toContain('ENABLED');
  });

  it('announces the reverse transition too — enforcement being turned OFF is the louder of the two', () => {
    let enabled = true;
    const binder = new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? enabled : 'info')));
    binder.onModuleInit();
    binder.onSettingsRefreshed();

    enabled = false;
    binder.onSettingsRefreshed();

    const lines = postureLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('DISABLED');
  });
});

/**
 * The defect was a SECOND claimant of the posture. Deleting it is only durable
 * if something notices when it grows back — two places asserting a security
 * posture is precisely how they drift apart, which is the whole reason this
 * line was wrong in the first place.
 *
 * `bootstrap()` cannot be unit-tested (the values live inside its closure), so
 * this reads the source. Coarse, but it fails loudly if anyone re-adds a
 * posture claim to a code path that provably cannot know the answer.
 */
describe('main.ts bootstrap log — does NOT claim a posture it cannot know', () => {
  // Resolved from `cwd` rather than `import.meta.url`: `apps/api` compiles as
  // CommonJS, and `tsc -p apps/api/tsconfig.json` rejects `import.meta` (TS1343)
  // even though vitest would run it happily. The suite runs from the repo root
  // or from `apps/api` depending on the invocation, so both are tried — and a
  // miss FAILS rather than vacuously passing.
  const MAIN = ['apps/api/src/main.ts', 'src/main.ts'].map((candidate) => resolve(process.cwd(), candidate)).find(existsSync);
  const source = MAIN ? readFileSync(MAIN, 'utf8') : '';

  it('located main.ts (a source-reading guard that cannot find its source proves nothing)', () => {
    expect(MAIN, `could not locate apps/api/src/main.ts from cwd ${process.cwd()}`).toBeDefined();
  });

  /** Comments explain the history; only executable lines may not claim a posture. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('does not resolve the enforcement switch at bootstrap time', () => {
    expect(code).not.toContain('isOriginEnforcementEnabled');
  });

  it('does not print an enforcement verdict', () => {
    expect(code).not.toMatch(/ORIGIN ENFORCEMENT IS/);
    expect(code).not.toMatch(/originEnforcement\s*:/);
    expect(code).not.toContain('allow_all_origins');
  });

  it('still records the STATIC facts that are true at boot regardless of the switch', () => {
    expect(code).toContain('credentials: false');
    expect(code).toContain('origin.enforcementEnabled');
  });
});
