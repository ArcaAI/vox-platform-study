/**
 * Regression gate for v1 clinical prompt fidelity.
 *
 * The v1 -> v2 migration silently altered 7 of the
 * 15 ArcaAI clinical prompt templates while porting them into
 * `07b-arcaai-clinical-content.ts` — two replaced with different documents,
 * one paraphrased with a heading dropped, one had a review-interval checkbox
 * flipped pre-ticked by a two-character edit, two had content added, and the
 * pre-summary was de-parameterized. Nothing detected it because nothing
 * pinned the expected content (see
 * docs/implementation/TASK-634-Pre-Summary-Summary-Prompt-Fidelity/README.md).
 *
 * This test asserts every seeded ArcaAI clinical content constant still
 * hashes to its pinned v1 sha256 (`./v1-clinical-prompt-checksums.fixture.ts`),
 * so a future re-paraphrase or accidental edit fails CI instead of shipping
 * silently.
 */

import { createHash } from 'crypto';

import { describe, it, expect } from 'vitest';

import {
  SURGERY_NEW_REFERRAL_CONTENT,
  SURGERY_FOLLOWUP_CONTENT,
  MEDICINE_NEW_REFERRAL_CONTENT,
  MEDICINE_FOLLOWUP_CONTENT,
  RHEUMATOLOGY_NEW_REFERRAL_CONTENT,
  RHEUMATOLOGY_FOLLOWUP_CONTENT,
  NEUROLOGY_NEW_REFERRAL_CONTENT,
  NEUROLOGY_FOLLOWUP_CONTENT,
  ORTHOPEDICS_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_REVIEW_CONTENT,
  HEMATOLOGY_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_REVISIT_CONTENT,
  BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT,
  BREAST_ENDOCRINE_FOLLOWUP_CONTENT,
  PRE_SUMMARY_CONTENT,
  DERMATOLOGY_NEW_REFERRAL_CONTENT,
  DERMATOLOGY_FOLLOWUP_CONTENT,
  DIETETICS_NEW_REFERRAL_CONTENT,
  DIETETICS_FOLLOWUP_CONTENT,
  NEPHROLOGY_NEW_REFERRAL_CONTENT,
  NEPHROLOGY_FOLLOWUP_CONTENT,
  SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT,
  SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT,
} from '../prisma/db_main/seed/07b-arcaai-clinical-content';
import { V1_CLINICAL_PROMPT_CHECKSUMS } from './v1-clinical-prompt-checksums.fixture';

/** Maps each fixture's `contentConstant` name to the actual imported string value. */
const CONTENT_BY_CONSTANT_NAME: Record<string, string> = {
  SURGERY_NEW_REFERRAL_CONTENT,
  SURGERY_FOLLOWUP_CONTENT,
  MEDICINE_NEW_REFERRAL_CONTENT,
  MEDICINE_FOLLOWUP_CONTENT,
  RHEUMATOLOGY_NEW_REFERRAL_CONTENT,
  RHEUMATOLOGY_FOLLOWUP_CONTENT,
  NEUROLOGY_NEW_REFERRAL_CONTENT,
  NEUROLOGY_FOLLOWUP_CONTENT,
  ORTHOPEDICS_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_REVIEW_CONTENT,
  HEMATOLOGY_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_REVISIT_CONTENT,
  BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT,
  BREAST_ENDOCRINE_FOLLOWUP_CONTENT,
  PRE_SUMMARY_CONTENT,
  DERMATOLOGY_NEW_REFERRAL_CONTENT,
  DERMATOLOGY_FOLLOWUP_CONTENT,
  DIETETICS_NEW_REFERRAL_CONTENT,
  DIETETICS_FOLLOWUP_CONTENT,
  NEPHROLOGY_NEW_REFERRAL_CONTENT,
  NEPHROLOGY_FOLLOWUP_CONTENT,
  SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT,
  SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT,
};

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('v1 clinical prompt fidelity fixture', () => {
  it('pins exactly the 23 ArcaAI clinical content constants', () => {
    expect(V1_CLINICAL_PROMPT_CHECKSUMS).toHaveLength(23);
    expect(Object.keys(CONTENT_BY_CONSTANT_NAME)).toHaveLength(23);
  });

  it.each(V1_CLINICAL_PROMPT_CHECKSUMS)(
    'seeded $contentConstant matches its pinned v1 sha256',
    ({ contentConstant, v1Sha256 }) => {
      const content = CONTENT_BY_CONSTANT_NAME[contentConstant];
      expect(
        content,
        `Fixture references unknown export "${contentConstant}" — it is not exported from ` +
          '07b-arcaai-clinical-content.ts (or not wired into this test\'s CONTENT_BY_CONSTANT_NAME map).',
      ).toBeDefined();

      const actualSha256 = sha256Hex(content);

      expect(
        actualSha256,
        `${contentConstant} has drifted from v1.\n` +
          `  expected (pinned v1) sha256: ${v1Sha256}\n` +
          `  actual (seeded) sha256:      ${actualSha256}\n` +
          'This means the seeded content no longer matches the v1 clinical prompt template. ' +
          `Re-extract ${contentConstant} from the RUNNING v1 pod (Rancher cluster c-9lwv8, ` +
          'namespace apps, pod apps-text-84c9774997-zhp2l) — never from a local HOPE checkout, ' +
          'which has diverged from production in both directions. If this divergence is an ' +
          'intentional, sign-off-approved content change (not silent drift), update the pinned ' +
          'hash in v1-clinical-prompt-checksums.fixture.ts with a Change History entry explaining why.',
      ).toBe(v1Sha256);
    },
  );
});
