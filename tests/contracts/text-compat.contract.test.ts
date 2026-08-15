/**
 * v1-compatible SMR summary shim CONTRACT tests (hermetic).
 *
 * Locks the frozen v1 response shapes by validating the
 * golden fixtures against the zod schemas in `smr-compat.schemas.ts`, and proves
 * the lock BITES by asserting that dropping a v1-required key fails. A future v2
 * change that reshapes a contract fails here before it can reach a migrated app.
 *
 * Runs under `pnpm test:unit` (root vitest, node env) — no live services.
 */

import { describe, it, expect } from 'vitest';
import {
  GOLDEN_ENHANCED_SUMMARY,
  GOLDEN_PRE_SUMMARY_RESPONSE,
  GOLDEN_SESSION_DATA,
  GOLDEN_SIMPLIFIED_SUMMARY,
  GOLDEN_SUMMARY_RESPONSE,
} from '../fixtures/smr-compat.fixture';
import {
  EnhancedMedicalSummarySchema,
  PreSummaryResponseSchema,
  SessionDataSchema,
  SimplifiedMedicalSummarySchema,
  SummaryResponseSchema,
} from './text-compat.schemas';

describe('SMR compat request contract (SessionData)', () => {
  it('accepts the golden SessionData', () => {
    const result = SessionDataSchema.safeParse(GOLDEN_SESSION_DATA);
    expect(result.success).toBe(true);
  });

  it('carries real per-turn conversation_segments (not one collapsed blob)', () => {
    expect(GOLDEN_SESSION_DATA.conversation_segments.length).toBeGreaterThan(1);
    const speakers = new Set(GOLDEN_SESSION_DATA.conversation_segments.map((s) => s.speaker));
    expect(speakers.size).toBeGreaterThan(1);
  });

  it('rejects a SessionData missing session_id (drift guard)', () => {
    const { session_id: _omit, ...withoutId } = GOLDEN_SESSION_DATA;
    expect(SessionDataSchema.safeParse(withoutId).success).toBe(false);
  });
});

describe('SimplifiedMedicalSummary contract (use_enhanced_format:false)', () => {
  it('accepts the golden Simplified summary', () => {
    expect(SimplifiedMedicalSummarySchema.safeParse(GOLDEN_SIMPLIFIED_SUMMARY).success).toBe(true);
  });

  it('tolerates unknown extra keys (forward compatible)', () => {
    const withExtra = { ...GOLDEN_SIMPLIFIED_SUMMARY, some_new_llm_field: 'x' };
    expect(SimplifiedMedicalSummarySchema.safeParse(withExtra).success).toBe(true);
  });

  it('rejects a Simplified summary missing chief_complaint (drift guard)', () => {
    const { chief_complaint: _omit, ...broken } = GOLDEN_SIMPLIFIED_SUMMARY;
    expect(SimplifiedMedicalSummarySchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a Simplified summary missing summary (drift guard)', () => {
    const { summary: _omit, ...broken } = GOLDEN_SIMPLIFIED_SUMMARY;
    expect(SimplifiedMedicalSummarySchema.safeParse(broken).success).toBe(false);
  });
});

describe('EnhancedMedicalSummary contract (use_enhanced_format:true)', () => {
  it('accepts the golden Enhanced summary', () => {
    expect(EnhancedMedicalSummarySchema.safeParse(GOLDEN_ENHANCED_SUMMARY).success).toBe(true);
  });

  it('rejects an Enhanced summary missing clinical_assessment (drift guard)', () => {
    const { clinical_assessment: _omit, ...broken } = GOLDEN_ENHANCED_SUMMARY;
    expect(EnhancedMedicalSummarySchema.safeParse(broken).success).toBe(false);
  });

  it('rejects an Enhanced summary whose primary_diagnosis lacks a diagnosis (drift guard)', () => {
    const broken = {
      ...GOLDEN_ENHANCED_SUMMARY,
      clinical_assessment: { ...GOLDEN_ENHANCED_SUMMARY.clinical_assessment, primary_diagnosis: { certainty: 'Suspected' } },
    };
    expect(EnhancedMedicalSummarySchema.safeParse(broken).success).toBe(false);
  });
});

describe('SummaryResponse envelope contract', () => {
  it('accepts the golden SummaryResponse', () => {
    expect(SummaryResponseSchema.safeParse(GOLDEN_SUMMARY_RESPONSE).success).toBe(true);
  });

  it('requires metadata.use_enhanced_format (the shim always sets it)', () => {
    const broken = { ...GOLDEN_SUMMARY_RESPONSE, metadata: { language: 'en' } };
    expect(SummaryResponseSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects an envelope missing session_id (drift guard)', () => {
    const { session_id: _omit, ...broken } = GOLDEN_SUMMARY_RESPONSE;
    expect(SummaryResponseSchema.safeParse(broken).success).toBe(false);
  });

  it('the envelope summary body validates as a concrete v1 summary shape', () => {
    const parsed = SummaryResponseSchema.parse(GOLDEN_SUMMARY_RESPONSE);
    // Simplified fixture → validates against the Simplified schema.
    expect(SimplifiedMedicalSummarySchema.safeParse(parsed.summary).success).toBe(true);
  });
});

describe('PreSummaryResponse contract', () => {
  it('accepts the golden PreSummaryResponse', () => {
    expect(PreSummaryResponseSchema.safeParse(GOLDEN_PRE_SUMMARY_RESPONSE).success).toBe(true);
  });

  it('accepts an empty sections array with pre_summary as source of truth', () => {
    const emptySections = {
      ...GOLDEN_PRE_SUMMARY_RESPONSE,
      structured_data: { title: 'Pre-Summary of Medical History', sections: [] },
    };
    expect(PreSummaryResponseSchema.safeParse(emptySections).success).toBe(true);
  });

  it('rejects a PreSummaryResponse missing pre_summary (drift guard)', () => {
    const { pre_summary: _omit, ...broken } = GOLDEN_PRE_SUMMARY_RESPONSE;
    expect(PreSummaryResponseSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a section item without text (drift guard)', () => {
    const broken = {
      ...GOLDEN_PRE_SUMMARY_RESPONSE,
      structured_data: { title: 'x', sections: [{ title: 's', items: [{ note: 'no text key' }] }] },
    };
    expect(PreSummaryResponseSchema.safeParse(broken).success).toBe(false);
  });
});
