import { describe, expect, it } from 'vitest';
import { mapGenerateToV1PreSummary, mapGenerateToV1Summary, parseSections } from '../summary-response.mapper';

const CREATED = new Date('2026-07-27T09:31:00.000Z');

describe('mapGenerateToV1Summary', () => {
  const simplifiedContent = JSON.stringify({ chief_complaint: 'chest tightness', summary: 'stable' });
  const enhancedContent = JSON.stringify({
    encounter_summary: { chief_complaint: 'chest tightness' },
    clinical_summary: { summary: 'stable' },
    quality_metrics: { completeness_score: 0.82, confidence_level: 'High' },
  });

  it('wraps the parsed Simplified summary and fills processing_time_ms from latency_ms', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, {
      sessionId: 'sess-1',
      useEnhanced: false,
      latencyMs: 1234,
      finishReason: 'stop',
      createdAt: CREATED,
    });
    expect(res.session_id).toBe('sess-1');
    expect(res.summary_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.summary.chief_complaint).toBe('chest tightness');
    expect(res.processing_time_ms).toBe(1234);
    expect(res.metadata.use_enhanced_format).toBe(false);
    expect(res.metadata.finish_reason).toBe('stop');
    // Simplified has no completeness score.
    expect(res.confidence_score).toBeNull();
  });

  it('reuses SMR task_id as summary_id when provided', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, {
      sessionId: 'sess-1',
      summaryId: 'task-abc-123',
      useEnhanced: false,
      createdAt: CREATED,
    });
    expect(res.summary_id).toBe('task-abc-123');
  });

  it('extracts confidence_score from Enhanced quality_metrics.completeness_score', () => {
    const res = mapGenerateToV1Summary(enhancedContent, {
      sessionId: 'sess-2',
      useEnhanced: true,
      createdAt: CREATED,
    });
    expect(res.confidence_score).toBe(0.82);
    expect(res.metadata.use_enhanced_format).toBe(true);
  });

  it('tolerates extra LLM keys and strips markdown code fences', () => {
    const fenced = '```json\n{"chief_complaint":"x","summary":"y","extra_key":42}\n```';
    const res = mapGenerateToV1Summary(fenced, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.summary.extra_key).toBe(42);
    expect(res.summary.summary).toBe('y');
  });

  // Reasoning models (many LM Studio GGUFs) emit their chain-of-thought INLINE
  // before the JSON — the summary must still be recovered, not lost to a parse error.
  it('strips a leading <think>…</think> reasoning block before the JSON', () => {
    const withThink = '<think>The patient reports chest tightness; likely stable.</think>\n{"chief_complaint":"x","summary":"y"}';
    const res = mapGenerateToV1Summary(withThink, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.summary.chief_complaint).toBe('x');
    expect(res.summary.summary).toBe('y');
  });

  it('recovers the JSON object from surrounding prose (unterminated think / preamble / trailing notes)', () => {
    const withProse =
      '<think>reasoning with no closing tag and a stray { brace\nHere is the summary:\n{"chief_complaint":"x","summary":"y"}\nHope that helps.';
    const res = mapGenerateToV1Summary(withProse, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.summary.chief_complaint).toBe('x');
    expect(res.summary.summary).toBe('y');
  });

  it('strips <think> even around a fenced JSON block', () => {
    const combo = '<think>thinking…</think>\n```json\n{"chief_complaint":"x","summary":"y"}\n```';
    const res = mapGenerateToV1Summary(combo, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.summary.summary).toBe('y');
  });

  it('echoes pre_summary_text into metadata only when provided', () => {
    const withPre = mapGenerateToV1Summary(simplifiedContent, {
      sessionId: 's',
      useEnhanced: false,
      preSummaryText: 'prior hx',
      createdAt: CREATED,
    });
    expect(withPre.metadata.pre_summary_text).toBe('prior hx');

    const withoutPre = mapGenerateToV1Summary(simplifiedContent, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(withoutPre.metadata).not.toHaveProperty('pre_summary_text');
  });

  it('echoes v1-parity labels (llm_provider / model_name / parsing_method / raw_llm_content) when provided', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, {
      sessionId: 's',
      useEnhanced: false,
      llmProvider: 'azure-openai',
      modelName: 'gpt-4o',
      parsingMethod: 'json_schema',
      rawLlmContent: simplifiedContent,
      createdAt: CREATED,
    });
    expect(res.metadata.llm_provider).toBe('azure-openai');
    expect(res.metadata.model_name).toBe('gpt-4o');
    expect(res.metadata.parsing_method).toBe('json_schema');
    expect(res.metadata.raw_llm_content).toBe(simplifiedContent);
  });

  it('nulls the v1-parity labels when not supplied (present, never undefined)', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.metadata.llm_provider).toBeNull();
    expect(res.metadata.model_name).toBeNull();
    expect(res.metadata.parsing_method).toBeNull();
    expect(res.metadata.raw_llm_content).toBeNull();
  });

  it('throws (→ 500) on non-JSON content', () => {
    expect(() => mapGenerateToV1Summary('not json at all', { sessionId: 's', useEnhanced: false, createdAt: CREATED })).toThrow();
  });

  it('defaults processing_time_ms to null when latency is absent', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.processing_time_ms).toBeNull();
  });
});

describe('parseSections / mapGenerateToV1PreSummary (v1 5-section guarantee)', () => {
  // TASK-634 D-09 — v1's LIVE order + naming (`Latest Dept Note`), verified
  // against the running v1 pod's `display_titles`.
  const EXPECTED_TITLES = [
    'Confirmed & Provisional Diagnoses',
    'Investigations (Latest Dept Note)',
    'Diagnostics & Trends',
    'Plan of Care (Latest Dept Note)',
    'Medications Prescribed (Latest Dept Note)',
  ];

  const allPresent = [
    '**Confirmed & Provisional Diagnoses**',
    '- Essential hypertension, on amlodipine 5mg',
    '- Hyperlipidemia',
    '**Investigations (Latest Dept Note)**',
    '- ECG normal',
    '**Diagnostics & Trends**',
    '- Weight stable',
    '**Plan of Care (Latest Dept Note):**',
    '- Continue current medications',
    '**Medications Prescribed (Latest Dept Note)**',
    '- Amlodipine 5mg OD',
  ].join('\n');

  it('emits all 5 canonical sections IN ORDER when all are present', () => {
    const structured = parseSections(allPresent);
    expect(structured.sections.map((s) => s.title)).toEqual(EXPECTED_TITLES);
    expect(structured.sections[0].items).toEqual([{ text: 'Essential hypertension, on amlodipine 5mg' }, { text: 'Hyperlipidemia' }]);
    expect(structured.sections[4].items).toEqual([{ text: 'Amlodipine 5mg OD' }]);
  });

  it('fills missing sections with a single "Not available" item, preserving order', () => {
    const someMissing = ['**Confirmed & Provisional Diagnoses**', '- Hypertension', '**Diagnostics & Trends**', '- Weight stable'].join('\n');
    const structured = parseSections(someMissing);
    expect(structured.sections.map((s) => s.title)).toEqual(EXPECTED_TITLES);
    expect(structured.sections[0].items).toEqual([{ text: 'Hypertension' }]);
    expect(structured.sections[2].items).toEqual([{ text: 'Weight stable' }]);
    // The 3 unparsed sections are filled.
    expect(structured.sections[1].items).toEqual([{ text: 'Not available' }]);
    expect(structured.sections[3].items).toEqual([{ text: 'Not available' }]);
    expect(structured.sections[4].items).toEqual([{ text: 'Not available' }]);
  });

  it('returns all 5 sections as "Not available" when nothing parses', () => {
    const structured = parseSections('just a paragraph of plain prose with no headings');
    expect(structured.sections.map((s) => s.title)).toEqual(EXPECTED_TITLES);
    for (const section of structured.sections) {
      expect(section.items).toEqual([{ text: 'Not available' }]);
    }
  });

  it('maps to PreSummaryResponse with pre_summary as the source of truth and 5 sections', () => {
    const res = mapGenerateToV1PreSummary(allPresent, CREATED);
    expect(res.pre_summary).toContain('Essential hypertension');
    expect(res.structured_data.title).toBe('Pre-Summary of Medical History');
    expect(res.structured_data.sections).toHaveLength(5);
    expect(res.created_at).toBe(CREATED.toISOString());
  });

  it('prepends the v1 title to pre_summary when absent', () => {
    const res = mapGenerateToV1PreSummary('plain prose without headings', CREATED);
    expect(res.pre_summary.startsWith('**Pre-Summary of Medical History**')).toBe(true);
    expect(res.structured_data.sections).toHaveLength(5);
  });
});
