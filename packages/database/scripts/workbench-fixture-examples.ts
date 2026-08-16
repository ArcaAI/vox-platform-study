// Deterministic, synthetic example data for the Workbench's `WorkflowTestFixture` surface
// (TASK-721 Phase C). PURE — no randomness, no wall-clock reads, no I/O: the SAME array on
// every call, so "fixed-seed" here means "reproducible," not "backed by a persisted seed row."
// Never copy production rows into this file — every value is authored, obviously synthetic
// placeholder content. See `packages/database/scripts/__tests__/workbench-fixture-examples.test.ts`
// for the PHI-shape scan (reuses TASK-700's `dna-phi-scan.ts` heuristics) that guards it.

export interface SyntheticFixtureExample {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export const SYNTHETIC_FIXTURE_EXAMPLES: readonly SyntheticFixtureExample[] = [
  {
    name: 'Two-speaker follow-up visit',
    description: 'A short synthetic follow-up consultation transcript, two speakers.',
    input: {
      transcript:
        'Clinician: How have you been feeling since the last visit? Patient: Overall better, the medication seems to be helping. ' +
        'Clinician: Any side effects to report? Patient: No, nothing notable.',
      speakerCount: 2,
    },
  },
  {
    name: 'New patient intake (minimal)',
    description: 'A minimal synthetic intake payload for a first-visit workflow.',
    input: {
      transcript: 'Clinician: Welcome, tell me a bit about what brings you in today. Patient: Just a routine check-up, no specific concerns.',
      visitType: 'new_patient',
    },
  },
  {
    name: 'Empty input (structure-only smoke test)',
    description: 'No transcript at all — exercises nodes that tolerate a missing payload field.',
    input: {},
  },
];

/** Reproducible accessor — a plain function, not a class, so tests never need to instantiate anything. */
export function syntheticFixtureExamples(): readonly SyntheticFixtureExample[] {
  return SYNTHETIC_FIXTURE_EXAMPLES;
}
