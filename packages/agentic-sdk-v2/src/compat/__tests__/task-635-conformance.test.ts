/**
 * @vitest-environment jsdom
 *
 * Conformance regression suite (COMPAT SDK layer).
 *
 * Locks the SDK half of R-C1 from the scorecard in
 *
 *   R-C1 — "Start recording → realtime TRANSCRIPT ONLY (no live summarization
 *   loop)". The API half (no live route on `text-compat`) is locked in
 *   `apps/api/src/modules/text-compat/__tests__/task-635-conformance.test.ts`;
 *   this file locks the client half: the compat barrel must not hand a
 *   migrating v1 app any live/streaming-summary hook to call.
 *
 * Sibling files: applications (R-T1/R-T2 DTO contract) and database (RF-2,
 * B-12) — see the api-layer file's header for the full map.
 *
 * DELIBERATELY NOT DUPLICATED: the compat barrel's positive export contract
 * (which v1 hook names and return shapes it DOES ship) is locked by
 * `contract.test.ts`. This file asserts only the NEGATIVE space.
 */

import { describe, expect, it } from 'vitest';

// The public compat surface — exactly what `import … from '@arcaai/vox/compat'`
// resolves to for a migrating v1 app.
import * as compat from '../../compat';

const exportedNames = Object.keys(compat);

describe('R-C1 — the compat SDK exposes no live-summarization hook', () => {
  it('exports no hook whose name implies a recording-time summarization loop', () => {
    const offenders = exportedNames.filter((name) =>
      /(live|realtime|running|streaming|incremental).*(summar|soap|note)|(summar|soap).*(live|realtime|stream)/i.test(name),
    );

    expect(offenders).toEqual([]);
  });

  it('ships exactly the summarization entry point v1 had — `useText` — and no live sibling', () => {
    // eliminated the `text` identifier, so the deprecated `useTEXT` alias
    // is gone and `useText` is the only name left to match. The predicate hunted
    // for `TEXT`/`Summar`, which now matches nothing — it has to name the entry
    // point it is guarding, or the assertion silently stops guarding anything.
    const summarizationExports = exportedNames.filter((name) => /^use(Text|.*Summar)/i.test(name));

    expect(summarizationExports).toEqual(['useText']);
  });

  it('exposes recording-time hooks for TRANSCRIPT only', () => {
    // The recording-time surface a v1 app drives: capture + STT (+ the v2-native
    // provider/language helpers). None of them produce a summary.
    for (const name of ['useAudioCapture', 'useArcaSpeechToText', 'useArcaSessionManager']) {
      expect(exportedNames).toContain(name);
    }
    expect(exportedNames).not.toContain('useLiveSummary');
    expect(exportedNames).not.toContain('useArcaLiveSummary');
    expect(exportedNames).not.toContain('useLiveDocumentation');
  });
});

// ---------------------------------------------------------------------------
// PENDING — assertions to add when C3 / C5 land
// ---------------------------------------------------------------------------
//
// * R-N1 — after C3: the NATIVE surface (`@arcaai/vox`, not `/compat`) gains a
//   live-summary hook whose event payload carries the additive
//   `metadata.agent = { id, name, versionId }` block. Assert that block's
//   presence on the native hook — and re-assert HERE that the compat barrel
//   still does NOT re-export it (R-C1 must survive the native feature landing;
//   the compat entry bundle is the exact place a convenience re-export would be
//   tempting, cf. the `useArcaSttLanguageModes` precedent).
// * R-N2 — after C5: no compat-side assertion expected (finalize lineage is a
//   server-side property); revisit only if the compat `useText` response DTO is
//   enriched with agent lineage.
