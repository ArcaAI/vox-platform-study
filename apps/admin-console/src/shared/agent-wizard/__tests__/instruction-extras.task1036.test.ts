/**
 * TASK-1036 C5 (OD-7, OD-22) — `instruction.documentTemplate { slug }` rides on the instruction
 * object, beside whichever of template / inline / fragments the author chose, and carries a slug
 * only (a document template always resolves to the latest approved version — never a pin).
 */
import { describe, expect, it } from 'vitest';
import { documentTemplateSlugOf, withDocumentTemplate } from '../instruction-extras';

describe('documentTemplateSlugOf', () => {
  it('reads the slug, and is null for every other shape', () => {
    expect(documentTemplateSlugOf({ systemPrompt: 'x', documentTemplate: { slug: 'soap' } })).toBe('soap');
    expect(documentTemplateSlugOf({ systemPrompt: 'x' })).toBeNull();
    expect(documentTemplateSlugOf(null)).toBeNull();
    expect(documentTemplateSlugOf({ documentTemplate: { slug: 3 } })).toBeNull();
    expect(documentTemplateSlugOf({ documentTemplate: 'soap' })).toBeNull();
  });
});

describe('withDocumentTemplate', () => {
  it('adds the block next to the existing instruction without mutating it', () => {
    const base = { promptTemplateId: 'tpl-1', promptVersionNumber: 2 };
    expect(withDocumentTemplate(base, 'soap')).toEqual({ ...base, documentTemplate: { slug: 'soap' } });
    expect(base).toEqual({ promptTemplateId: 'tpl-1', promptVersionNumber: 2 });
  });

  it('removes the block when the slug is cleared, and returns undefined when nothing is left', () => {
    expect(withDocumentTemplate({ systemPrompt: 'x', documentTemplate: { slug: 'soap' } }, null)).toEqual({ systemPrompt: 'x' });
    expect(withDocumentTemplate({ documentTemplate: { slug: 'soap' } }, null)).toBeUndefined();
    expect(withDocumentTemplate(undefined, null)).toBeUndefined();
  });

  it('can carry a document template with no prompt chosen yet', () => {
    expect(withDocumentTemplate(undefined, 'soap')).toEqual({ documentTemplate: { slug: 'soap' } });
  });
});
