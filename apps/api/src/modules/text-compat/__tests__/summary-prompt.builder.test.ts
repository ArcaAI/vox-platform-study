import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreSummaryRequest } from '../dto/pre-summary.request';
import type { SessionDataDto } from '../dto/session-data.dto';
import {
  buildPreSummaryPrompt,
  buildSummaryPrompt,
  PRE_SUMMARY_TEMPLATE_VARIABLES,
  renderPreSummaryTemplate,
  resolveV1LanguageName,
  V1_PRE_SUMMARY_SYSTEM_PROMPT,
  V1_PRE_SUMMARY_TEMPLATE,
} from '../summary-prompt.builder';

/**
 * v1 corpus extracted from the RUNNING v1 TEXT pod — never
 * retyped. `rendered-*.txt` were produced by Python's own `str.format()` over
 * `template.txt`, i.e. v1's interpolation engine, so they are goldens for what
 * v2 must assemble.
 */
const V1_FIXTURES = join(__dirname, 'fixtures', 'v1-pre-summary');
const readFixture = (name: string): string => readFileSync(join(V1_FIXTURES, name), 'utf8');
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

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

  // The doctor's DNA writing-style is folded into the system prompt as
  // style guidance when provided; omitted entirely when absent (D5).
  it('folds the DNA writing style into the system prompt when dnaStyleText is provided', () => {
    const { system } = buildSummaryPrompt(baseSession(), { dnaStyleText: 'Terse, active voice, no abbreviations.' });
    expect(system).toContain('Terse, active voice, no abbreviations.');
  });

  it('omits any DNA style directive when dnaStyleText is absent', () => {
    const { system } = buildSummaryPrompt(baseSession());
    expect(system.toLowerCase()).not.toContain('writing style');
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

  // The department template is injected as AUTHORITATIVE steering
  // and 13 seeded templates instruct "content in conversation language,
  // headings in English". A bare `Language: X` label loses to that specific
  // clause. The gateway's directive must explicitly name and override the
  // conflict, not just state the target language (R3).
  it('overrides a conflicting "conversation language" clause in the governed instruction with an explicit English directive (R3)', () => {
    const { system } = buildSummaryPrompt(baseSession(), {
      governedInstruction: 'strictly follows these headings (content in conversation language, headings in English)',
    });
    expect(system).toContain('content in conversation language, headings in English');
    expect(system).toContain('Write ALL summary content in English');
    expect(system).toContain('regardless of any conflicting language instruction in the department instruction above');
  });

  // R1 — English is the default output language, including when `language` is
  // empty/absent (the normal case per the ticket).
  it('defaults to an explicit English directive when language is empty/absent (R1)', () => {
    expect(buildSummaryPrompt(baseSession()).system).toContain('Write ALL summary content in English');
    expect(buildSummaryPrompt(baseSession(), { language: '' }).system).toContain('Write ALL summary content in English');
  });

  // R1 is UNCONDITIONAL (owner decision 2026-08-10, option (a)): `language` is
  // the SOURCE locale and never selects the output language. Verified live —
  // the client sends `ml-en` (a code-switch marker), which the previous
  // "honour an explicit request" behaviour read as "write Malayalam" and
  // produced a fully Malayalam clinical note.
  it.each(['ml', 'ml-en', 'ml-IN', 'hi-IN', 'ta-IN', 'en', undefined])(
    'writes the note in English regardless of the source language (%s)',
    (language) => {
      const { system } = buildSummaryPrompt(baseSession(), { language });
      expect(system).toContain('Write ALL summary content in English');
      expect(system).not.toContain('Write ALL summary content in Malayalam');
    },
  );

  // R4 — section headings stay in English regardless of the content language.
  it('keeps section headings in English regardless of the source language', () => {
    const { system } = buildSummaryPrompt(baseSession(), { language: 'ml' });
    expect(system).toContain('Section headings stay in English');
  });

  // A space join lands the directive mid-paragraph; it must be
  // its own distinct line so it reads as an instruction, not run-on prose.
  it('emits the language directive as its own line, not mid-paragraph', () => {
    const { system } = buildSummaryPrompt(baseSession(), { language: 'ml' });
    const lines = system.split('\n');
    expect(lines).toContain(
      "Write ALL summary content in English, regardless of the transcript's language and regardless of any conflicting language instruction in the department instruction above (for example, an instruction to write content in the conversation language). Translate any non-English clinical content into English. Section headings stay in English.",
    );
  });

  it('emits a JSON-only instruction so structured output round-trips', () => {
    const { system } = buildSummaryPrompt(baseSession());
    expect(system.toLowerCase()).toContain('json');
  });

  it('injects v1 department-specific section guidance for the 6 non-medicine departments', () => {
    const { system } = buildSummaryPrompt(baseSession(), { department: 'Surgery', visitType: 'New Referral' });
    // Guidance derived from DEPT_VISIT_SCHEMAS[surgery:new_referral] field set.
    expect(system).toContain('Department-specific documentation focus');
    expect(system).toContain('Presenting Complaints');
    expect(system).toContain('Fitness For Surgery');
  });

  it('normalizes the visit type before selecting the department template (Review → followup)', () => {
    const { system } = buildSummaryPrompt(baseSession(), { department: 'Orthopedics', visitType: 'Review' });
    expect(system).toContain('Department-specific documentation focus');
    expect(system).toContain('Next Review Date');
  });

  it('keeps General/Medicine on the generic conversational path (no dept guidance)', () => {
    const general = buildSummaryPrompt(baseSession(), { department: 'General', visitType: 'New Referral' });
    expect(general.system).not.toContain('Department-specific documentation focus');
    const medicine = buildSummaryPrompt(baseSession(), { department: 'Medicine', visitType: 'Follow-up' });
    expect(medicine.system).not.toContain('Department-specific documentation focus');
  });

  it('adds no dept guidance for a department without a v1 template', () => {
    const { system } = buildSummaryPrompt(baseSession(), { department: 'Cardiology', visitType: 'New Referral' });
    expect(system).not.toContain('Department-specific documentation focus');
  });

  it('injects the governed instruction and suppresses the static dept guidance', () => {
    const { system } = buildSummaryPrompt(baseSession(), {
      department: 'Surgery',
      visitType: 'New Referral',
      governedInstruction: 'Capture fitness for surgery and pre-operative optimization.',
    });
    expect(system).toContain('Capture fitness for surgery and pre-operative optimization');
    // The tenant's governed template supersedes the static v1 field-set steering.
    expect(system).not.toContain('Department-specific documentation focus');
    // The v1 wire directive is still present so the response shape is unchanged.
    expect(system).toContain('single JSON object');
  });
});

/**
 * Sarvam pre-translation is a general-purpose MT engine with no
 * clinical vocabulary. Verified live against `hope-v2-dev` 2026-08-10 on a real
 * `ml-en` consultation: it rendered `aceclofenac 100 mg` as "Acetaminophen"
 * (a different drug class), turned `marked ... subchondral sclerosis` into
 * "mild", and dropped `medial joint space narrowing` and the referred
 * physiotherapist's name. The same payload WITHOUT pre-translation summarized
 * every one of those correctly.
 *
 * The fix keeps Sarvam in the loop (it still produces the readable English the
 * note is written from) but stops its output being the ONLY text the model
 * sees: each turn now carries the clinician's original words alongside the
 * translation, and the original is authoritative for clinical facts.
 */
describe('buildSummaryPrompt — bilingual transcript (Sarvam translation + original)', () => {
  const bilingualSession = (): SessionDataDto =>
    ({
      session_id: 'sess-ml',
      created_at: '2026-08-10T07:12:26Z',
      conversation_segments: [
        {
          speaker: 'provider',
          text: 'Acetaminophen 100 mg is given when there is severe pain.',
          original_text: 'severe pain വരുമ്പോൾ കഴിക്കാൻ aceclofenac 100 mg PRN തരികയാണ്.',
          timestamp: '2026-08-10T07:12:30Z',
        },
      ],
    }) as SessionDataDto;

  it('renders the original turn alongside the translation', () => {
    const { user } = buildSummaryPrompt(bilingualSession());
    expect(user).toContain('provider: Acetaminophen 100 mg is given when there is severe pain.');
    expect(user).toContain('aceclofenac 100 mg PRN');
  });

  it('makes the original authoritative for clinical facts in the system prompt', () => {
    const { system } = buildSummaryPrompt(bilingualSession());
    expect(system).toContain('machine translation');
    expect(system).toMatch(/take the value from the original line/i);
    // The failure modes actually observed must be named, not implied.
    expect(system).toMatch(/drug names/i);
    expect(system).toMatch(/severity/i);
  });

  it('adds no bilingual directive and no extra lines when no segment carries an original', () => {
    const { system, user } = buildSummaryPrompt(baseSession());
    expect(system).not.toContain('machine translation');
    expect(user).not.toContain('(original');
  });

  it('does not repeat the turn when the original is identical to the translation', () => {
    const session = {
      session_id: 'sess-en',
      created_at: '2026-08-10T07:12:26Z',
      conversation_segments: [{ speaker: 'patient', text: 'Chest tightness.', original_text: 'Chest tightness.', timestamp: '2026-08-10T07:12:30Z' }],
    } as SessionDataDto;
    const { user } = buildSummaryPrompt(session);
    expect(user).not.toContain('(original');
    expect(user.match(/Chest tightness\./g)).toHaveLength(1);
  });
});

describe('buildPreSummaryPrompt (v1 1:1)', () => {
  /** Mirrors the kwargs used to render `rendered-full.txt` with Python `str.format`. */
  const req = (): PreSummaryRequest =>
    ({
      current_department: 'Cardiology',
      visit_type: 'Follow-up',
      age: '58',
      dob: '1968-03-14',
      gender: 'male',
      formatted_vitals: 'BP 142/88 mmHg, HR 78 bpm',
      formatted_test_results: 'Troponin normal; LDL 150',
      formatted_previous_visits: '2026-05-10 Cardiology: HTN review.',
      language: 'en',
    }) as PreSummaryRequest;

  it('carries the v1 pre-summary body byte-exact (sha256 d1b71800…, 3155 B)', () => {
    expect(sha256(V1_PRE_SUMMARY_TEMPLATE)).toBe('d1b718001948db0aa05607803e96f30b429946e73774964eb6353c95b039b5ef');
    expect(Buffer.byteLength(V1_PRE_SUMMARY_TEMPLATE, 'utf8')).toBe(3155);
    expect(V1_PRE_SUMMARY_TEMPLATE).toBe(readFixture('template.txt'));
  });

  it('carries the v1 pre-summary system prompt byte-exact (sha256 277d94d5…, 336 B)', () => {
    expect(sha256(V1_PRE_SUMMARY_SYSTEM_PROMPT)).toBe('277d94d56d3dc687d8fd1b52fef9a87aa3101846ac748cbe3672946ebb56d19d');
    expect(Buffer.byteLength(V1_PRE_SUMMARY_SYSTEM_PROMPT, 'utf8')).toBe(336);
    expect(V1_PRE_SUMMARY_SYSTEM_PROMPT).toBe(readFixture('system.txt'));
  });

  it('stays byte-identical to the seeded ArcaAI pre-summary template', () => {
    // The seeded tenant row (PRE_SUMMARY_CONTENT) and this in-code default are
    // two copies of the same v1 body — a request may render either. Read the
    // seed SOURCE (not @arcaai/database runtime code) so drift fails here.
    const seedSource = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        'packages',
        'database',
        'src',
        'prisma',
        'db_main',
        'seed',
        '07b-arcaai-clinical-content.ts',
      ),
      'utf8',
    );
    const escaped = JSON.stringify(V1_PRE_SUMMARY_TEMPLATE).slice(1, -1);
    // The body carries no quote/backslash characters, so the double-quoted and
    // prettier's single-quoted literal differ only in the delimiter.
    expect(seedSource.includes(`"${escaped}"`) || seedSource.includes(`'${escaped}'`)).toBe(true);
  });

  it('declares exactly the nine v1 template variables', () => {
    expect([...PRE_SUMMARY_TEMPLATE_VARIABLES]).toEqual([
      'current_department',
      'visit_type',
      'safe_age',
      'safe_dob',
      'safe_gender',
      'safe_vitals',
      'formatted_test_results',
      'formatted_previous_visits',
      'language_name',
    ]);
    // Every placeholder present in the verbatim body must be declared.
    const found = new Set([...V1_PRE_SUMMARY_TEMPLATE.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
    expect([...found].sort()).toEqual([...PRE_SUMMARY_TEMPLATE_VARIABLES].sort());
  });

  it('GOLDEN — renders byte-identically to v1 for a fully populated request', () => {
    const { system, user } = buildPreSummaryPrompt(req());
    expect(system).toBe(readFixture('system.txt'));
    expect(user).toBe(readFixture('rendered-full.txt'));
    expect(user).not.toMatch(/\{[A-Za-z_]/);
  });

  it("GOLDEN — an empty request renders v1's defaults byte-identically", () => {
    const { user } = buildPreSummaryPrompt({} as PreSummaryRequest);
    expect(user).toBe(readFixture('rendered-defaults.txt'));
  });

  it('GOLDEN — a Malayalam request renders "Language: Malayalam" (D-11)', () => {
    const { user } = buildPreSummaryPrompt({ ...req(), language: 'ml-IN' } as PreSummaryRequest);
    expect(user).toBe(readFixture('rendered-ml.txt'));
    expect(user).toContain('- Language: Malayalam');
    expect(user).not.toContain('Language: English');
  });

  it('maps language codes through v1 LANGUAGE_MAP (base subtag; unknown → English)', () => {
    expect(resolveV1LanguageName('en')).toBe('English');
    expect(resolveV1LanguageName('ml')).toBe('Malayalam');
    expect(resolveV1LanguageName('ml-IN')).toBe('Malayalam');
    expect(resolveV1LanguageName('fr')).toBe('English');
    expect(resolveV1LanguageName(undefined)).toBe('English');
  });

  it('substitutes in ONE pass — a brace inside a value is never re-interpreted', () => {
    const rendered = renderPreSummaryTemplate('Dept={current_department} Vitals={safe_vitals}', {
      current_department: '{safe_vitals}',
      formatted_vitals: 'BP 120/80',
    } as PreSummaryRequest);
    expect(rendered).toBe('Dept={safe_vitals} Vitals=BP 120/80');
  });

  it('leaves unknown placeholders untouched rather than blanking them', () => {
    expect(renderPreSummaryTemplate('{not_a_v1_variable}', {} as PreSummaryRequest)).toBe('{not_a_v1_variable}');
  });

  it('uses the governed tenant template as the body when one resolves', () => {
    const { user } = buildPreSummaryPrompt(req(), { governedInstruction: 'Highlight {current_department} risk stratification.' });
    expect(user).toBe('Highlight Cardiology risk stratification.');
  });

  /**
   * TASK-890 §3.2 (wave-2b close) — the v1-compat seam.
   *
   * A tenant's governed pre-summary instruction is the SAME seeded row the native plane
   * assembles, and those rows now carry `{{context.x}}`. Left on the single-brace substituter,
   * this plane shipped the LITERAL `{{context.current_department}}` to the model while the
   * native plane rendered the value — the same template, two answers, on the compat plane that
   * exists to keep one behaviour.
   *
   * The discriminator is the CONTENT, not the caller: `V1_PRE_SUMMARY_TEMPLATE` is byte-pinned
   * single-brace v1 content and keeps the v1 substituter, unchanged.
   */
  describe('a governed body written in the ONE grammar renders through it', () => {
    it('renders `{{context.x}}`, both under `context.*` and bare', () => {
      const { user } = buildPreSummaryPrompt(req(), {
        governedInstruction: 'Dept={{context.current_department}} Lang={{language_name}}',
      });

      expect(user).toBe('Dept=Cardiology Lang=English');
    });

    it('binds an unresolved reference EMPTY rather than refusing the pre-summary', () => {
      const { user } = buildPreSummaryPrompt(req(), { governedInstruction: 'X=[{{context.not_a_v1_variable}}]' });

      expect(user).toBe('X=[]');
    });

    it('honours `default("…")` over the empty binding', () => {
      const { user } = buildPreSummaryPrompt(req(), { governedInstruction: '{{context.absent | default("none")}}' });

      expect(user).toBe('none');
    });

    it('uses a body that does not PARSE verbatim rather than costing the caller its summary', () => {
      const { user } = buildPreSummaryPrompt(req(), { governedInstruction: 'broken {{ unterminated' });

      expect(user).toBe('broken {{ unterminated');
    });

    it('leaves the byte-pinned v1 body on the single-brace substituter', () => {
      expect(renderPreSummaryTemplate('Dept={current_department}', req())).toBe('Dept=Cardiology');
    });
  });

  // DNA writing style folded into the pre-summary system prompt.
  it('appends the DNA writing style to the system prompt, leaving the body untouched', () => {
    const { system, user } = buildPreSummaryPrompt(req(), { dnaStyleText: 'Bullet points, minimal prose.' });
    expect(system.startsWith(readFixture('system.txt'))).toBe(true);
    expect(system).toContain('Bullet points, minimal prose.');
    expect(user).toBe(readFixture('rendered-full.txt'));
  });
});
