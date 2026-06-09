/**
 * Standalone fixture for the linked-evidence clinician review screen
 * (TASK-330 Phase 1, Lane J).
 *
 * The harness draft/provenance endpoints land in a parallel lane, so this
 * fixture matches the documented `SummaryMeta.citationsMap` contract exactly,
 * letting the review UI render and be exercised on its own. Evidence offsets
 * are derived from the transcript at module load via `indexOf`, so the
 * highlight spans are always correct (no hand-counted offsets to drift).
 */
import type { ClaimEvidence, ClinicalReviewData } from '@arcaai/vox';

const TRANSCRIPT_ID = 'ctx-transcript-1';

const TRANSCRIPT_TEXT = `Doctor: Good morning, Mr. Smith. How have you been since our last visit?
Patient: Good morning, doctor. The chest pain has improved quite a bit since starting the new medication. I still get some discomfort when I climb stairs, but it's much less frequent.
Doctor: That's good to hear. How about the shortness of breath?
Patient: It's better too. I can walk about two blocks now before I need to rest. Before, I could barely walk one.
Doctor: Excellent improvement. Let me check your vitals. Blood pressure is 138 over 85, heart rate 72. That's better than last time. Have you been taking all your medications as prescribed?
Patient: Yes, the aspirin, the statin, and the blood pressure medication. I sometimes forget the evening metformin though.
Doctor: It's important to take the metformin consistently for your diabetes management. Your HbA1c was 7.2 last time, and we want to bring that down. Let me listen to your heart... I hear a slight murmur, grade 2 over 6, which is consistent with what we found before. Lungs are clear.
Patient: Is the murmur something to worry about?
Doctor: It's stable from your last visit, so we'll continue monitoring it. Based on your stress test results showing moderate ischemia, the cardiology team has recommended we proceed with cardiac catheterization. I'd like to schedule that for next week.
Patient: Okay, doctor. What should I expect?
Doctor: It's a minimally invasive procedure. They'll insert a catheter through your wrist or groin to look at your coronary arteries. We'll discuss the details and consent at your pre-procedure visit. For now, continue all your current medications, and please don't forget the evening metformin.`;

/** Resolve a quote to a transcript evidence span by char offset. */
function span(quote: string): ClaimEvidence {
  const startOffset = TRANSCRIPT_TEXT.indexOf(quote);
  if (startOffset < 0) {
    throw new Error(`sample-review fixture: quote not found in transcript: "${quote}"`);
  }
  return { transcriptContextItemId: TRANSCRIPT_ID, startOffset, endOffset: startOffset + quote.length, quote };
}

export const SAMPLE_REVIEW: ClinicalReviewData = {
  consultationId: 'consult-demo-1',
  noteContextItemId: 'ctx-note-1',
  modelName: 'ollama/llama3.1:8b-instruct',
  status: 'PENDING_REVIEW',
  transcripts: [{ contextItemId: TRANSCRIPT_ID, label: 'Live transcription', text: TRANSCRIPT_TEXT }],
  sensorScores: {
    entityFaithfulness: 0.82,
    coverage: 0.9,
    schemaValid: 1,
    citationPresence: 0.78,
    numericDose: 0.6,
  },
  citationsMap: {
    claims: [
      // --- S: Subjective ---
      {
        id: 'c-s1',
        text: 'Chest pain improved since starting the new medication.',
        section: 'S',
        confidence: 0.93,
        status: 'verified',
        evidence: [span('The chest pain has improved quite a bit since starting the new medication')],
        entityRefs: ['ent-chest-pain'],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-s2',
        text: 'Exertional tolerance improved — able to walk two blocks before resting.',
        section: 'S',
        confidence: 0.88,
        status: 'verified',
        evidence: [span('I can walk about two blocks now before I need to rest')],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-s3',
        text: 'Patient denies palpitations or syncope.',
        section: 'S',
        confidence: 0.34,
        status: 'unverified',
        evidence: [],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
      // --- O: Objective ---
      {
        id: 'c-o1',
        text: 'BP 138/85 mmHg, HR 72 bpm.',
        section: 'O',
        confidence: 0.95,
        status: 'verified',
        evidence: [span('Blood pressure is 138 over 85, heart rate 72')],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-o2',
        text: 'Grade 2/6 systolic murmur, stable; lungs clear.',
        section: 'O',
        confidence: 0.84,
        status: 'verified',
        evidence: [span('I hear a slight murmur, grade 2 over 6'), span('Lungs are clear')],
        entityRefs: ['ent-murmur'],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-o3',
        text: 'HbA1c 6.5% — glycaemic control at goal.',
        section: 'O',
        confidence: 0.41,
        status: 'flagged',
        // Numeric mismatch: the transcript states 7.2%, not 6.5% — the
        // numeric/dose sensor flags it and links the contradicting evidence.
        evidence: [span('HbA1c was 7.2')],
        entityRefs: ['ent-hba1c'],
        knowledgeChunkIds: [],
      },
      // --- A: Assessment ---
      {
        id: 'c-a1',
        text: 'Coronary artery disease with moderate ischemia on stress testing.',
        section: 'A',
        confidence: 0.9,
        status: 'verified',
        evidence: [span('stress test results showing moderate ischemia')],
        entityRefs: ['ent-cad', 'ent-ischemia'],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-a2',
        text: 'Type 2 diabetes mellitus, suboptimal glycaemic control.',
        section: 'A',
        confidence: 0.66,
        status: 'verified',
        evidence: [span('for your diabetes management')],
        entityRefs: ['ent-t2dm'],
        knowledgeChunkIds: [],
      },
      // --- P: Plan ---
      {
        id: 'c-p1',
        text: 'Proceed with cardiac catheterization, scheduled next week.',
        section: 'P',
        confidence: 0.92,
        status: 'verified',
        evidence: [span('proceed with cardiac catheterization'), span('schedule that for next week')],
        entityRefs: ['ent-cath'],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-p2',
        text: 'Start metoprolol 25 mg PO BID.',
        section: 'P',
        confidence: 0.22,
        status: 'flagged',
        // Fabrication: no beta-blocker was discussed in the transcript, so the
        // entity-faithfulness sensor flags it with no supporting provenance.
        evidence: [],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
      {
        id: 'c-p3',
        text: 'Continue current medications, including the evening metformin.',
        section: 'P',
        confidence: 0.87,
        status: 'verified',
        evidence: [span('continue all your current medications'), span("don't forget the evening metformin")],
        entityRefs: ['ent-metformin'],
        knowledgeChunkIds: [],
      },
    ],
  },
};
