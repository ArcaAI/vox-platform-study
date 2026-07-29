/**
 * Unit tests for the shared NLP → NamedEntity mapper.
 *
 * The mapper is the single source of truth for the NLP `/classify/tokens`
 * contract used by BOTH durable persistence paths (summary.service.extractEntities
 * and ner.processor). The real contract is `{ text, entity_type, confidence,
 * position: { start, end } }`; legacy/alternate names are defensive fallbacks only.
 */

import { describe, it, expect } from 'vitest';
import { namedEntityPropsFromNlp } from '../namedEntityFromNlp';

const CTX = { tenantId: 'tenant-1', contextItemId: 'ctx-1' };

describe('namedEntityPropsFromNlp', () => {
  it('maps the real NLP contract (text / entity_type / confidence / position)', () => {
    const props = namedEntityPropsFromNlp({ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 8, end: 15 } }, CTX);

    expect(props).toEqual({
      tenantId: 'tenant-1',
      contextItemId: 'ctx-1',
      text: 'aspirin',
      className: 'MEDICATION',
      confidence: 0.9,
      startOffset: 8,
      endOffset: 15,
    });
  });

  it('preserves 0 confidence and 0 offsets (nullish coalescing, not ||)', () => {
    const props = namedEntityPropsFromNlp({ text: 'x', entity_type: 'T', confidence: 0, position: { start: 0, end: 0 } }, CTX);

    expect(props.confidence).toBe(0);
    expect(props.startOffset).toBe(0);
    expect(props.endOffset).toBe(0);
  });

  it('leaves offsets undefined when position is absent', () => {
    const props = namedEntityPropsFromNlp({ text: 'headache', entity_type: 'SYMPTOM' }, CTX);

    expect(props.startOffset).toBeUndefined();
    expect(props.endOffset).toBeUndefined();
    expect(props.confidence).toBeUndefined();
  });

  it('defaults text and className to empty strings when nothing is present', () => {
    const props = namedEntityPropsFromNlp({}, CTX);

    expect(props.text).toBe('');
    expect(props.className).toBe('');
  });

  it('falls back to legacy value/type/start/end names', () => {
    const props = namedEntityPropsFromNlp({ value: 'Diabetes', type: 'CONDITION', confidence: 0.95, start: 13, end: 21 }, CTX);

    expect(props).toMatchObject({
      text: 'Diabetes',
      className: 'CONDITION',
      confidence: 0.95,
      startOffset: 13,
      endOffset: 21,
    });
  });

  it('falls back to NamedEntity-native className/startOffset/endOffset names', () => {
    const props = namedEntityPropsFromNlp({ text: 'MRI', className: 'PROCEDURE', startOffset: 5, endOffset: 8 }, CTX);

    expect(props).toMatchObject({
      text: 'MRI',
      className: 'PROCEDURE',
      startOffset: 5,
      endOffset: 8,
    });
  });

  it('prefers the real contract over legacy fields when both are present', () => {
    const props = namedEntityPropsFromNlp(
      {
        text: 'real',
        entity_type: 'REAL_TYPE',
        position: { start: 1, end: 2 },
        // legacy noise that must NOT win
        value: 'legacy',
        type: 'LEGACY_TYPE',
        start: 99,
        end: 100,
      },
      CTX,
    );

    expect(props).toMatchObject({
      text: 'real',
      className: 'REAL_TYPE',
      startOffset: 1,
      endOffset: 2,
    });
  });

  // The NLP producer now emits ontology codes; the shared mapper
  // carries them onto the NamedEntity props so BOTH durable write paths
  // (ner.processor + summary.extractEntities) persist coded rows. RED before the
  // mapper maps them (they were dropped → columns written null).
  it('maps the five ontology codes (umls/snomed/rxnorm/icd/loinc → camelCase columns)', () => {
    const props = namedEntityPropsFromNlp(
      {
        text: 'metformin',
        entity_type: 'MEDICATION',
        confidence: 0.97,
        position: { start: 14, end: 23 },
        umls_cui: 'C0025598',
        snomed_code: null,
        rxnorm_code: '6809',
        icd_code: null,
        loinc_code: null,
      },
      CTX,
    );

    expect(props).toMatchObject({
      text: 'metformin',
      className: 'MEDICATION',
      umlsCui: 'C0025598',
      rxnormCode: '6809',
    });
  });

  it('leaves ontology codes undefined when the NLP entity carries none', () => {
    const props = namedEntityPropsFromNlp({ text: 'headache', entity_type: 'SYMPTOM' }, CTX);

    expect(props.umlsCui).toBeUndefined();
    expect(props.snomedCode).toBeUndefined();
    expect(props.rxnormCode).toBeUndefined();
    expect(props.icdCode).toBeUndefined();
    expect(props.loincCode).toBeUndefined();
  });
});
