/**
 * Boot-time audit — B1 regression (G1 closure).
 *
 * Proves two things:
 *  1. Against the REAL controllers, every route the HOPE Node SDK calls
 *     day-1 carries `@RequiredScopes(...)` metadata (`SDK_DAY1_SCOPED_ROUTES`
 *     is exhaustive and every entry passes).
 *  2. The audit actually CATCHES drift: a synthetic route list pointing at a
 *     handler with no `@RequiredScopes(...)` throws, and a stale method name
 *     throws too (so the audit itself can't silently no-op on a rename).
 */
import { describe, it, expect } from 'vitest';
import { RequiredScopes } from '../../decorators';
import { auditApiKeyRequiredScopes, SDK_DAY1_SCOPED_ROUTES } from '../api-key-scope-audit';

describe('boot-time API-key scope audit', () => {
  it('passes for the real HOPE Node SDK day-1 surface (SmrCompatController, ConsultationController, ConsultationJobController)', () => {
    expect(() => auditApiKeyRequiredScopes()).not.toThrow();
  });

  // Asserts the route SET, not a count. A bare `toHaveLength(n)` fails on any
  // legitimate addition without saying what changed — and, worse, passes if a
  // route is swapped for a different one. The SDK's method→route map is the
  // thing that must stay in sync, so name it.
  it('covers exactly the SDK day-1 method→route surface', () => {
    const covered = SDK_DAY1_SCOPED_ROUTES.map(({ controller, method }) => `${controller.name}.${method}`).sort();

    expect(covered).toEqual(
      [
        // Stateless v1-compat shims — hope.summarization.*
        'SmrCompatController.presummary',
        'SmrCompatController.summarySync',
        // Consultation-bound generation — hope.consultations.summaries.generate*
        'ConsultationController.generatePreSummary',
        'ConsultationController.generatePreSummaryAsync',
        'ConsultationController.generateSummary',
        'ConsultationController.generateSummaryAsync',
        // Consultation-bound reads/writes — hope.consultations.*
        'ConsultationController.getById',
        'ConsultationController.getLatestPreSummary',
        'ConsultationController.getLatestSummary',
        'ConsultationController.getSummaries',
        'ConsultationController.updateSummary',
        // Async jobs — hope.jobs.*
        'ConsultationJobController.cancelJob',
        'ConsultationJobController.getJob',
        'ConsultationJobController.streamJob',
      ].sort(),
    );
  });

  it('throws when a route in the list has no @RequiredScopes(...) metadata', () => {
    class Orphan {
      unscoped() {}
    }

    expect(() => auditApiKeyRequiredScopes([{ controller: Orphan, method: 'unscoped' }])).toThrow(
      /Orphan\.unscoped[\s\S]*no[\s\S]*@RequiredScopes/,
    );
  });

  it('throws when a route in the list DOES carry @RequiredScopes(...) metadata (sanity: the pass case is not a false negative)', () => {
    class Scoped {
      @RequiredScopes('consultation:report:read')
      covered() {}
    }

    expect(() => auditApiKeyRequiredScopes([{ controller: Scoped, method: 'covered' }])).not.toThrow();
  });

  it('throws with a stale-target message when the named method no longer exists (catches a rename silently dropping the audit)', () => {
    class Renamed {}

    expect(() => auditApiKeyRequiredScopes([{ controller: Renamed, method: 'goneNow' }])).toThrow(/does not exist[\s\S]*audit target is stale/);
  });

  it('lists every offender in one error when multiple routes drift', () => {
    class OrphanA {
      a() {}
    }
    class OrphanB {
      b() {}
    }

    expect(() =>
      auditApiKeyRequiredScopes([
        { controller: OrphanA, method: 'a' },
        { controller: OrphanB, method: 'b' },
      ]),
    ).toThrow(/OrphanA\.a[\s\S]*OrphanB\.b|OrphanB\.b[\s\S]*OrphanA\.a/);
  });
});
