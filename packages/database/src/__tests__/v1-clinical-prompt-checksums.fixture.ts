/**
 * Pinned v1 sha256 checksums for the 23 ArcaAI clinical
 * prompt templates (22 department x visit-type summary bodies + the
 * tenant-wide pre-summary).
 *
 * Phase 8a added the last 8 bodies (dermatology, dietetics, nephrology and
 * surgical oncology x new-referral/follow-up). v1 supports ELEVEN departments
 * x 2 visit types = 22 bodies; the original migration ported only seven
 * departments, so those four had no v2 counterpart to drift from — a gap the
 * Phase 7 fixture could not detect, because it pinned only what was ported.
 *
 * WHY THIS EXISTS
 *
 * The v1 -> v2 migration silently altered 7 of these
 * 15 templates while porting them into
 * `packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content.ts`:
 * two were replaced with entirely different documents (Surgery x2), one was
 * paraphrased with a heading dropped (Medicine - Follow-up), one had a
 * review-interval checkbox flipped from unticked to pre-ticked by a
 * two-character edit (Orthopedics - New Referral, `☐` -> `☒`), two had
 * clinical content added that v1 never had (Hematology x2), and the
 * pre-summary was de-parameterized (its `{single_brace}` placeholders were
 * replaced with static prose). Nothing in the test suite detected any of
 * this, because nothing pinned the expected byte content — the drift was
 * only found via a manual 15-agent byte-exact audit against the live v1 pod.
 * See docs/implementation/TASK-634-Pre-Summary-Summary-Prompt-Fidelity/README.md
 * section 2.9 (D-07) for the full audit table and drift taxonomy.
 *
 * These hashes turn "did the seed content drift from v1?" from a
 * multi-hour forensic investigation into a single failing CI assertion.
 *
 * SOURCE OF TRUTH
 *
 * Every hash below was extracted byte-exact (base64 pipeline, never
 * model-retyped) from the RUNNING v1 deployment — Rancher cluster `c-9lwv8`,
 * namespace `apps`, pod `apps-smr-84c9774997-zhp2l` — and independently
 * re-verified. The deployed pod is the ONLY valid source for these values.
 * A local v1 HOPE checkout is NOT a valid source: it has diverged from
 * production in both directions (some checkout content was never deployed;
 * some deployed content was never committed back to the checkout). If a
 * future re-extraction is needed, it MUST come from the pod that is live at
 * that time, not from any local checkout or from this file's own history.
 *
 * DO NOT edit these hash values to make a failing test pass. A mismatch
 * means the seed content drifted from v1 — fix the seed content (or get
 * explicit clinical/product sign-off to intentionally diverge and update
 * this fixture with a Change History entry explaining why), never the
 * reverse.
 */

export interface V1ClinicalPromptChecksum {
  /** Exported `const` name in 07b-arcaai-clinical-content.ts carrying this body. */
  readonly contentConstant: string;
  /** ArcaAI PromptTemplate id (07b-arcaai-clinical-templates.ts ARCAAI_CLINICAL_TEMPLATE_IDS). */
  readonly templateId: string;
  /** sha256 hex digest of the exact v1 CONTENT string, extracted from the running v1 pod. */
  readonly v1Sha256: string;
}

export const V1_CLINICAL_PROMPT_CHECKSUMS: readonly V1ClinicalPromptChecksum[] = [
  {
    contentConstant: 'SURGERY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000010',
    v1Sha256: '082f81eef30434bf2e810049ef33d38cbba53deec117e75c915dfce096d28685',
  },
  {
    contentConstant: 'SURGERY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000011',
    v1Sha256: '3aea7e6a3facb973e5cdc0292d1bfaeb57d14184358805d68c7d8995253e2a2d',
  },
  {
    contentConstant: 'MEDICINE_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000012',
    v1Sha256: '19cf6a024684c3102bc089d6f71c6405f033ab4cb832e8dddba0f83af76975cc',
  },
  {
    contentConstant: 'MEDICINE_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000013',
    v1Sha256: '38d3f0f400c4d129d798304b09bd445e879578c0cfa2ef85701d6414fb91f6fd',
  },
  {
    contentConstant: 'RHEUMATOLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000014',
    v1Sha256: '75f52e15488247fb17593fe491f2dfe80d3333ab8e74dad4f783fdf8f83eecff',
  },
  {
    contentConstant: 'RHEUMATOLOGY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000015',
    v1Sha256: '202b5e50602665e925d40d671cfce04d1090877a2d9a9c0fd005d79ad404f57e',
  },
  {
    contentConstant: 'NEUROLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000016',
    v1Sha256: 'ed6ebc57e158686628f465d45cd6828f0d49c3b213ecc8203598e2a592e5402e',
  },
  {
    contentConstant: 'NEUROLOGY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000017',
    v1Sha256: '03fede6bda4538a0c16f407958afaa267da05ea066c465766a98f0251449cfee',
  },
  {
    contentConstant: 'ORTHOPEDICS_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000018',
    v1Sha256: '017c955f3b052b8f80d917e5046111ad40522a121688c49f5eb3e70571f6c895',
  },
  {
    contentConstant: 'ORTHOPEDICS_REVIEW_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000019',
    v1Sha256: '00793f68aa6fc1d8a891738b2e81d8522c82e74a307a93ac0140efcbb128a930',
  },
  {
    contentConstant: 'HEMATOLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000020',
    v1Sha256: 'c86f9408dc36063ed25af31335beb8cffb5e398e3b12ff261520f2486ee0e7a4',
  },
  {
    contentConstant: 'HEMATOLOGY_REVISIT_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000021',
    v1Sha256: '865b4a31db2c3b54c39b144d50085e1f2cef6289052e4b807cff25bda6a29b90',
  },
  {
    contentConstant: 'BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000022',
    v1Sha256: '8bc3073ba3ebfe58e4449162e116b5fe199f9c4c18bb0de9c7bafebaa657b609',
  },
  {
    contentConstant: 'BREAST_ENDOCRINE_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000023',
    v1Sha256: '15155247c9441188b29a267a0d9535ad55dec778850a4be62bc2635800a2d02c',
  },
  {
    contentConstant: 'PRE_SUMMARY_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000024',
    v1Sha256: 'd1b718001948db0aa05607803e96f30b429946e73774964eb6353c95b039b5ef',
  },
  // The four departments the original migration never ported.
  {
    contentConstant: 'DERMATOLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000025',
    v1Sha256: 'b99ab4f4952016ed8e5c2a16e5ead2d8d9f4c602466180ea317387024d17bdb5',
  },
  {
    contentConstant: 'DERMATOLOGY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000026',
    v1Sha256: 'd237427271bd120f0adec4fbdeddcc4367b305b0a3f5cc4cd16901e210d51907',
  },
  {
    contentConstant: 'DIETETICS_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000027',
    v1Sha256: '351041078487e1c1bca510d18fe9ea85b7cf7cfdee749ec28eb4350841e46e07',
  },
  {
    contentConstant: 'DIETETICS_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000028',
    v1Sha256: '715a394f0e11be7b8ffefd74b0f2051ef44f67c5df7af7aacc45539917cbd0b2',
  },
  {
    contentConstant: 'NEPHROLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000029',
    v1Sha256: '24e6eb6b735bf94b7e712c97b23452b34e9048ab858709cfc749786f6624769d',
  },
  {
    contentConstant: 'NEPHROLOGY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000030',
    v1Sha256: '53841fda6205cf572420c1f4cecfe7ad9e7c1382feed7683355422c806cf919a',
  },
  {
    contentConstant: 'SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000031',
    v1Sha256: '419e577751a8310d11676296fad0f4aa16138e13977b9b7f86cc35bb2cca9cf7',
  },
  {
    contentConstant: 'SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT',
    templateId: '71000000-0000-0000-0001-000000000032',
    v1Sha256: '6c9c122c725b1d2a364b852240fcd9fc4bdf577317a963a6faaa91ba9c54097b',
  },
] as const;
