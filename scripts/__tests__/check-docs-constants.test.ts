import { describe, expect, it } from 'vitest';

import { API_KEY_SCOPE_PRESETS, OPEN_REFUSAL_CODES } from '../../packages/types/src/index';
import { checkDocsConstants, fencedBlocks, knownScopes, resolvesOnClient } from '../check-docs-constants';

/**
 * A gate nobody has watched fail might be asserting nothing. Each case below is one way the
 * guides can drift from the code, and the gate has to go red on every one of them — and stay
 * green on the tokens that merely LOOK like scopes and codes.
 */

/** A stand-in for `HopeClient` — the checker only ever walks property paths. */
const client = {
  consultations: { open: () => {}, listContext: () => {}, streams: { liveSummary: () => {} } },
  workflows: { schema: () => {}, reviews: { get: () => {}, decide: () => {} } },
};

/**
 * Every declared refusal code and preset scope, as prose. The coverage half of the checker demands
 * each be mentioned somewhere, so a fixture that omits them would fail every case for one reason.
 */
const APPENDIX = ['', ...OPEN_REFUSAL_CODES, ...API_KEY_SCOPE_PRESETS.flatMap((preset) => preset.scopes)].join('\n');

function guide(body: string): { name: string; contents: string }[] {
  return [{ name: 'guide.md', contents: `${body}\n${APPENDIX}` }];
}

describe('fencedBlocks', () => {
  it('returns each block body and ignores the prose between them', () => {
    expect(fencedBlocks('prose\n```ts\ninside\n```\nmore prose\n```\nsecond\n```\n')).toEqual(['inside', 'second']);
  });

  it('drops an unterminated block rather than swallowing the rest of the file', () => {
    expect(fencedBlocks('```\nopen forever\n')).toEqual([]);
  });
});

describe('knownScopes', () => {
  it('unions both registries and every preset scope', () => {
    const scopes = knownScopes();
    expect(scopes.has('consultation:session:read')).toBe(true);
    expect(scopes.has('svc:webhook:event:write')).toBe(true);
    expect(scopes.has('workflow:definition:read')).toBe(true);
  });
});

describe('resolvesOnClient', () => {
  it('walks a nested namespace', () => {
    expect(resolvesOnClient('.workflows.reviews.decide', client)).toBe(true);
  });

  it('rejects a path whose last step does not exist', () => {
    expect(resolvesOnClient('.workflows.reviews.approve', client)).toBe(false);
  });
});

describe('checkDocsConstants', () => {
  it('passes a block whose scopes, codes and calls all exist', () => {
    const report = checkDocsConstants(
      guide('```ts\n// scope consultation:session:write\nawait hope.consultations.listContext(id); // 400 CONTEXT_SCHEMA_VIOLATION\n```'),
      client,
    );
    expect(report.failures).toEqual([]);
    expect(report.scopes).toContain('consultation:session:write');
    expect(report.codes).toContain('CONTEXT_SCHEMA_VIOLATION');
    expect(report.calls).toContain('hope.consultations.listContext');
  });

  it('fails an invented scope', () => {
    const report = checkDocsConstants(guide('```\nconsultation:invented:read\n```'), client);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('consultation:invented:read');
  });

  it('fails an invented refusal code on a line that is about a refusal', () => {
    const report = checkDocsConstants(guide('```\n400 code: MADE_UP_REFUSAL\n```'), client);
    expect(report.failures[0]).toContain('MADE_UP_REFUSAL');
  });

  it('fails an SDK method that no longer exists', () => {
    const report = checkDocsConstants(guide('```ts\nawait hope.consultations.listContextItems(id);\n```'), client);
    expect(report.failures[0]).toContain('hope.consultations.listContextItems');
  });

  it('accepts SCHEMA_IMPACT_UNACKNOWLEDGED, which is a publish gate rather than an open refusal', () => {
    expect(checkDocsConstants(guide('```\n400 code: SCHEMA_IMPACT_UNACKNOWLEDGED\n```'), client).failures).toEqual([]);
  });

  it('ignores env vars, constant names and enum members that are not about a refusal', () => {
    const report = checkDocsConstants(
      guide('```bash\nHOPE_API_URL=http://localhost:8868\nexport PENDING_REVIEW=1\n```\n```ts\nOPEN_REFUSAL_CODES\n```'),
      client,
    );
    expect(report.failures).toEqual([]);
  });

  it('ignores prose outside a fenced block', () => {
    expect(checkDocsConstants(guide('The scope consultation:invented:read is not real.'), client).failures).toEqual([]);
  });

  it('fails when a declared refusal code is mentioned nowhere in the guides', () => {
    const report = checkDocsConstants([{ name: 'guide.md', contents: 'Nothing here.' }], client);
    expect(report.undocumented).toContain('WORKFLOW_CONTEXT_INCOMPATIBLE');
    expect(report.failures.some((failure) => failure.includes('WORKFLOW_CONTEXT_INCOMPATIBLE'))).toBe(true);
  });
});
