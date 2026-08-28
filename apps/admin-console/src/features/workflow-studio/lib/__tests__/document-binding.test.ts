/**
 * DD-2's document binding, as a pure reader/writer/comparator over one node's
 * `config` — the half of the control that has no DOM in it.
 *
 * The two rules these tests exist to hold down:
 *
 *   1. The console must READ a pin exactly as the compiler does. `buildCompilerContext`
 *      (`workflow-definition.service.ts`) drops any `documentVersionNumber` that is not an
 *      integer >= 1, so a UI that displayed `0` or `2.5` as "pinned to v0" would be describing
 *      a binding the compiled artifact does not contain.
 *   2. The console must never WRITE a key the admin did not choose. Both keys are OPTIONAL on
 *      all five generation schemas, and `0` is not a legal pin anywhere in the stack
 *      (`minimum: 1` in the node config schema, `versionNumber >= 1` on the compiled shape,
 *      `ge=1` on both pydantic models). "No pin" is encoded by ABSENCE, never by a zero.
 */
import { describe, expect, it } from 'vitest';
import { documentPinState, readDocumentBinding, withDocumentTemplate, withDocumentVersion } from '../document-binding';

const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';

describe('readDocumentBinding', () => {
  it('reads a template id and an integer pin', () => {
    expect(readDocumentBinding({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 })).toEqual({
      templateId: TEMPLATE_ID,
      pinnedVersionNumber: 4,
    });
  });

  it('reports an absent pin as null rather than 0 — absence is the encoding of "follows the template"', () => {
    expect(readDocumentBinding({ documentTemplateId: TEMPLATE_ID })).toEqual({ templateId: TEMPLATE_ID, pinnedVersionNumber: null });
  });

  it('rejects the values the compiler itself drops (0, negatives, fractions, strings)', () => {
    for (const bad of [0, -1, 2.5, '3', null, undefined]) {
      expect(readDocumentBinding({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: bad }).pinnedVersionNumber).toBeNull();
    }
  });

  it('treats an empty template id as no binding', () => {
    expect(readDocumentBinding({ documentTemplateId: '' }).templateId).toBeNull();
    expect(readDocumentBinding({}).templateId).toBeNull();
  });
});

describe('documentPinState', () => {
  it('unpinned when the node carries no pin — this is a legitimate configuration, not staleness', () => {
    expect(documentPinState(null, 5)).toBe('unpinned');
  });

  it('current when the pin matches the template’s own pin', () => {
    expect(documentPinState(5, 5)).toBe('current');
  });

  it('behind when the template has moved on', () => {
    expect(documentPinState(4, 5)).toBe('behind');
  });

  it('ahead when the template was rolled BACK past this node’s pin', () => {
    // Reachable: `POST /admin/document-templates/:id/pin` is explicitly the rollback path, so a
    // node can end up pinned above the version the template now serves. Calling that "behind"
    // would put a "New v3 available" badge on a node already at v5 — a lie, not a nudge.
    expect(documentPinState(5, 3)).toBe('ahead');
  });

  it('unresolved when the template serves nothing yet (never published) — not a staleness verdict', () => {
    expect(documentPinState(4, null)).toBe('unresolved');
  });
});

describe('withDocumentTemplate / withDocumentVersion — optionality is preserved by construction', () => {
  it('binding a template writes ONLY the id key', () => {
    expect(withDocumentTemplate({ taskKey: 'text.finalize' }, TEMPLATE_ID)).toEqual({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID });
  });

  it('clearing the template REMOVES both keys rather than writing null or 0', () => {
    const cleared = withDocumentTemplate({ taskKey: 'text.finalize', documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 }, null);
    expect(Object.hasOwn(cleared, 'documentTemplateId')).toBe(false);
    expect(Object.hasOwn(cleared, 'documentVersionNumber')).toBe(false);
    expect(cleared).toEqual({ taskKey: 'text.finalize' });
  });

  it('switching to a DIFFERENT template drops the old pin — v4 of one template is not v4 of another', () => {
    const next = withDocumentTemplate({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 }, OTHER_TEMPLATE_ID);
    expect(next).toEqual({ documentTemplateId: OTHER_TEMPLATE_ID });
  });

  it('re-selecting the SAME template keeps the pin', () => {
    const next = withDocumentTemplate({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 }, TEMPLATE_ID);
    expect(next).toEqual({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 });
  });

  it('unpinning REMOVES the key — never 0, which every layer of the stack rejects', () => {
    const next = withDocumentVersion({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 }, null);
    expect(Object.hasOwn(next, 'documentVersionNumber')).toBe(false);
    expect(next).toEqual({ documentTemplateId: TEMPLATE_ID });
  });

  it('pinning writes the chosen integer and nothing else', () => {
    expect(withDocumentVersion({ documentTemplateId: TEMPLATE_ID }, 3)).toEqual({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 3 });
  });

  it('refuses to write a pin below 1, the floor shared by the schema, the compiled shape and both pydantic models', () => {
    const next = withDocumentVersion({ documentTemplateId: TEMPLATE_ID, documentVersionNumber: 4 }, 0);
    expect(Object.hasOwn(next, 'documentVersionNumber')).toBe(false);
  });

  it('leaves unrelated config keys untouched in every direction', () => {
    const base = { taskKey: 'text.live', temperature: 0.2, promptTemplateId: 'p-1', promptVersionNumber: 2 };
    expect(withDocumentTemplate(base, TEMPLATE_ID)).toMatchObject(base);
    expect(withDocumentVersion({ ...base, documentTemplateId: TEMPLATE_ID }, 3)).toMatchObject(base);
  });
});
