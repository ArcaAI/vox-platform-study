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
    expect(res.summary.chief_complaint).toBe('chest tightness');
    expect(res.processing_time_ms).toBe(1234);
    expect(res.metadata.use_enhanced_format).toBe(false);
    expect(res.metadata.finish_reason).toBe('stop');
    // Simplified has no completeness score.
    expect(res.confidence_score).toBeNull();
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

  it('never leaks raw_llm_content into metadata', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.metadata).not.toHaveProperty('raw_llm_content');
  });

  it('throws (→ 500) on non-JSON content', () => {
    expect(() => mapGenerateToV1Summary('not json at all', { sessionId: 's', useEnhanced: false, createdAt: CREATED })).toThrow();
  });

  it('defaults processing_time_ms to null when latency is absent', () => {
    const res = mapGenerateToV1Summary(simplifiedContent, { sessionId: 's', useEnhanced: false, createdAt: CREATED });
    expect(res.processing_time_ms).toBeNull();
  });
});

describe('parseSections / mapGenerateToV1PreSummary', () => {
  const markdown = [
    '## Pre-Summary of Medical History',
    '',
    '**Confirmed & Provisional Diagnoses**',
    '- Essential hypertension, on amlodipine 5mg',
    '- Hyperlipidemia',
    '',
    '**Plan of Care**',
    '- Continue current medications',
  ].join('\n');

  it('parses headings and bullet items into structured sections', () => {
    const structured = parseSections(markdown);
    expect(structured).not.toBeNull();
    expect(structured!.title).toBe('Pre-Summary of Medical History');
    expect(structured!.sections).toHaveLength(2);
    expect(structured!.sections[0].title).toBe('Confirmed & Provisional Diagnoses');
    expect(structured!.sections[0].items).toEqual([{ text: 'Essential hypertension, on amlodipine 5mg' }, { text: 'Hyperlipidemia' }]);
  });

  it('returns null when there are no recognizable sections', () => {
    expect(parseSections('just a paragraph of plain prose with no headings')).toBeNull();
  });

  it('maps to PreSummaryResponse with pre_summary as the source of truth', () => {
    const res = mapGenerateToV1PreSummary(markdown, CREATED);
    expect(res.pre_summary).toContain('Essential hypertension');
    expect(res.structured_data.sections).toHaveLength(2);
    expect(res.created_at).toBe(CREATED.toISOString());
  });

  it('falls back to empty sections when the markdown has none', () => {
    const res = mapGenerateToV1PreSummary('plain prose without headings', CREATED);
    expect(res.pre_summary).toBe('plain prose without headings');
    expect(res.structured_data.title).toBe('Pre-Summary of Medical History');
    expect(res.structured_data.sections).toEqual([]);
  });
});
