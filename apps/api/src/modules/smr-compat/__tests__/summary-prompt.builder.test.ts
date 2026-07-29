import { describe, expect, it } from 'vitest';
import type { PreSummaryRequest } from '../dto/pre-summary.request';
import type { SessionDataDto } from '../dto/session-data.dto';
import { buildPreSummaryPrompt, buildSummaryPrompt } from '../summary-prompt.builder';

const baseSession = (): SessionDataDto =>
  ({
    session_id: 'sess-1',
    created_at: '2026-07-27T09:30:00Z',
    conversation_segments: [
      { speaker: 'provider', text: 'What brings you in today?', timestamp: '2026-07-27T09:30:05Z' },
      { speaker: 'patient', text: 'Chest tightness for three days.', timestamp: '2026-07-27T09:30:12Z', confidence: 0.94 },
    ],
  }) as SessionDataDto;

describe('buildSummaryPrompt', () => {
  it('renders one line per transcript turn (fix v1 F2 — not one collapsed segment)', () => {
    const { user } = buildSummaryPrompt(baseSession());
    expect(user).toContain('provider: What brings you in today?');
    expect(user).toContain('patient: Chest tightness for three days.');
    // Two distinct turns → two transcript lines.
    const transcriptLines = user.split('\n').filter((l) => l.startsWith('provider:') || l.startsWith('patient:'));
    expect(transcriptLines).toHaveLength(2);
  });

  it('routes department + visit type into the system prompt', () => {
    const { system } = buildSummaryPrompt(baseSession(), { department: 'Cardiology', visitType: 'New Referral' });
    expect(system).toContain('Cardiology');
    expect(system).toContain('New Referral');
  });

  it('folds pre_summary_text only when enrichment is enabled', () => {
    const session = baseSession();
    session.pre_summary_text = 'Known hypertension on amlodipine.';

    const disabled = buildSummaryPrompt(session, { includePreSummary: false });
    expect(disabled.user).not.toContain('Known hypertension on amlodipine.');

    const enabled = buildSummaryPrompt(session, { includePreSummary: true });
    expect(enabled.user).toContain('Known hypertension on amlodipine.');
  });

  it('prefers structured test_results over test_results_text', () => {
    const session = baseSession();
    session.test_results = [{ test_name: 'Troponin', test_type: 'lab', result: 'normal' }];
    session.test_results_text = 'PLAIN TEXT SHOULD NOT WIN';
    const { user } = buildSummaryPrompt(session);
    expect(user).toContain('Troponin (lab): normal');
    expect(user).not.toContain('PLAIN TEXT SHOULD NOT WIN');
  });

  it('falls back to *_text when no structured records are present', () => {
    const session = baseSession();
    session.previous_visits_text = '2026-05 Cardiology: BP review.';
    const { user } = buildSummaryPrompt(session);
    expect(user).toContain('2026-05 Cardiology: BP review.');
  });

  it('selects Malayalam language guidance for ml', () => {
    const { system } = buildSummaryPrompt(baseSession(), { language: 'ml' });
    expect(system).toContain('Malayalam');
  });

  it('emits a JSON-only instruction so structured output round-trips', () => {
    const { system } = buildSummaryPrompt(baseSession());
    expect(system.toLowerCase()).toContain('json');
  });
});

describe('buildPreSummaryPrompt', () => {
  const req = (): PreSummaryRequest =>
    ({
      current_department: 'Cardiology',
      visit_type: 'Follow-up',
      age: '58',
      gender: 'male',
      formatted_vitals: 'BP 142/88, HR 78',
      formatted_test_results: 'Troponin normal; LDL 150',
      formatted_previous_visits: '2026-05-10 Cardiology: HTN review.',
      language: 'en',
    }) as PreSummaryRequest;

  it('routes department + visit type and folds all pre-formatted context', () => {
    const { system, user } = buildPreSummaryPrompt(req());
    expect(system).toContain('Cardiology');
    expect(system).toContain('Follow-up');
    expect(user).toContain('BP 142/88, HR 78');
    expect(user).toContain('Troponin normal; LDL 150');
    expect(user).toContain('2026-05-10 Cardiology: HTN review.');
    expect(user).toContain('Age: 58');
  });

  it('defaults department to General and visit type to Medical examination', () => {
    const { system } = buildPreSummaryPrompt({} as PreSummaryRequest);
    expect(system).toContain('General');
    expect(system).toContain('Medical examination');
  });
});
