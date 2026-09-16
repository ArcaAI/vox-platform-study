import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/shared/api';
import { publishRejection } from '../publish-error';

describe('publishRejection', () => {
  it('extracts structural `problems` from a not-publishable 400', () => {
    const error = new GatewayError(400, 'The context schema definition is not publishable.', 'Bad Request', {
      message: 'The context schema definition is not publishable.',
      problems: ['definition.kinds[0].primitive `WEIRD` is not one of STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED'],
    });

    expect(publishRejection(error)).toEqual({
      problems: ['definition.kinds[0].primitive `WEIRD` is not one of STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED'],
      breakingChanges: undefined,
      impact: undefined,
      impactUnacknowledged: false,
    });
  });

  it('extracts `breakingChanges` from a refused breaking-change 400', () => {
    const error = new GatewayError(400, 'This definition breaks clients built against the current version — kind `note` removed.', 'Bad Request', {
      breakingChanges: ['kind `note` removed'],
    });

    expect(publishRejection(error)).toEqual({
      problems: undefined,
      breakingChanges: ['kind `note` removed'],
      impact: undefined,
      impactUnacknowledged: false,
    });
  });

  it('extracts the `impact` block from an unacknowledged-impact 400 and marks it as such', () => {
    const impact = {
      schemaId: 's-1',
      againstVersion: 4,
      workflows: [
        {
          definitionId: 'wd-2',
          slug: 'ortho',
          name: 'Ortho intake',
          versionNumber: 3,
          status: 'PUBLISHED',
          isActive: true,
          binding: 'pinned' as const,
          boundVersion: 2,
          verdict: 'refuses' as const,
          problems: ['/referral: not declared in the bound version v2'],
        },
      ],
      agents: [],
    };
    const error = new GatewayError(400, 'Publishing this version would make 1 workflow refuse new consultations.', 'Bad Request', {
      code: 'SCHEMA_IMPACT_UNACKNOWLEDGED',
      impact,
    });

    expect(publishRejection(error)).toEqual({ problems: undefined, breakingChanges: undefined, impact, impactUnacknowledged: true });
  });

  it('does not read an `impact` block as an unacknowledged refusal when the code says otherwise', () => {
    const error = new GatewayError(400, 'nope', 'Bad Request', {
      code: 'SOMETHING_ELSE',
      impact: { schemaId: 's-1', againstVersion: 4, workflows: [], agents: [] },
    });

    expect(publishRejection(error)?.impactUnacknowledged).toBe(false);
  });

  it('returns null for a non-GatewayError', () => {
    expect(publishRejection(new Error('boom'))).toBeNull();
  });

  it('returns null for a GatewayError with neither `problems` nor `breakingChanges`', () => {
    expect(publishRejection(new GatewayError(404, 'Context schema s-1 not found'))).toBeNull();
  });

  it('returns null for a non-400 GatewayError even if `details` happens to carry the shape', () => {
    expect(publishRejection(new GatewayError(500, 'boom', undefined, { problems: ['x'] }))).toBeNull();
  });
});
