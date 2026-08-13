import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/taphuynh/Downloads/v3';
const dept = readFileSync(`${SRC}/DEPARTMENT_PROMPTS_v3.md`, 'utf8');
const pre = readFileSync(`${SRC}/PRE_SUMMARY_PROMPT_v3.md`, 'utf8');

// md section number -> export base name (file order != section order; v3 also
// lists §2/§3 last, same as v2).
const BY_SECTION = {
  0: 'SURGERY_NEW_REFERRAL',
  1: 'SURGERY_FOLLOWUP',
  2: 'RHEUMATOLOGY_NEW_REFERRAL',
  3: 'RHEUMATOLOGY_FOLLOWUP',
  4: 'MEDICINE_NEW_REFERRAL',
  5: 'MEDICINE_FOLLOWUP',
  6: 'ORTHOPEDICS_NEW_REFERRAL',
  7: 'ORTHOPEDICS_REVIEW',
  8: 'HEMATOLOGY_NEW_REFERRAL',
  9: 'HEMATOLOGY_REVISIT',
  10: 'BREAST_ENDOCRINE_NEW_REFERRAL',
  11: 'BREAST_ENDOCRINE_FOLLOWUP',
  12: 'DIETETICS_NEW_REFERRAL',
  13: 'DIETETICS_FOLLOWUP',
  14: 'DERMATOLOGY_NEW_REFERRAL',
  15: 'DERMATOLOGY_FOLLOWUP',
  16: 'NEPHROLOGY_NEW_REFERRAL',
  17: 'NEPHROLOGY_FOLLOWUP',
  18: 'NEUROLOGY_NEW_REFERRAL',
  19: 'NEUROLOGY_FOLLOWUP',
  20: 'SURGICAL_ONCOLOGY_NEW_REFERRAL',
  21: 'SURGICAL_ONCOLOGY_FOLLOWUP',
};

const lines = dept.split('\n');
const bodies = new Map();
let section = null;
let buf = null;
for (const line of lines) {
  const h = /^## (\d+)\) /.exec(line);
  if (h && buf === null) { section = Number(h[1]); continue; }
  if (line === '```text' && buf === null && section !== null) { buf = []; continue; }
  if (line === '```' && buf !== null) {
    if (bodies.has(section)) throw new Error(`duplicate fence for section ${section}`);
    bodies.set(section, buf.join('\n') + '\n');
    buf = null; section = null; continue;
  }
  if (buf !== null) buf.push(line);
}
if (buf !== null) throw new Error('unterminated fence');

const missing = Object.keys(BY_SECTION).filter((n) => !bodies.has(Number(n)));
if (missing.length) throw new Error(`missing sections: ${missing.join(',')}`);
if (bodies.size !== 22) throw new Error(`expected 22 bodies, got ${bodies.size}`);

// Block A must be byte-identical across all 22 (INTEGRATION_NOTES_v3.md §3.1 —
// it is duplicated into every prompt, not referenced).
const blockA = new Set();
for (const body of bodies.values()) {
  const m = /=== SOURCE-OF-TRUTH PROTOCOL[\s\S]*?=== END SOURCE-OF-TRUTH PROTOCOL ===/.exec(body);
  if (!m) throw new Error('missing Block A');
  blockA.add(m[0]);
}
if (blockA.size !== 1) throw new Error(`Block A has ${blockA.size} variants, expected 1`);

// RULE 6 in v3 REQUIRES annotated ASR name repair; the annotation forms are the
// safety argument for permitting repair at all (INTEGRATION_NOTES_v3.md §3.2).
for (const [n, name] of Object.entries(BY_SECTION)) {
  const body = bodies.get(Number(n));
  if (!body.includes('transcribed as')) throw new Error(`${name}: lost the ASR repair annotation form`);
}

// Author-only HTML comment in PRE_SUMMARY_PROMPT_v3.md
// (`<!-- FILE METADATA — DO NOT PASTE INTO HOPE ... -->`). INTEGRATION_NOTES_v3.md
// §2: that comment is not part of the prompt; the prompt starts at
// `## Medical AI Pre-Summary Prompt`. Strip it (and the blank lines it leaves)
// so the seeded body is the prompt only. Department fences never contain it.
function stripAuthorFileMetadata(text) {
  return text.replace(/<!--[\s\S]*?FILE METADATA[\s\S]*?-->\s*/g, '');
}

// Pre-summary: prompt body only, markdown escapes removed so {placeholders} survive.
const preContent = stripAuthorFileMetadata(pre).replace(/\\([*_])/g, '$1');
if (/\\/.test(preContent)) throw new Error('residual backslash in pre-summary');
if (!preContent.startsWith('## Medical AI Pre-Summary Prompt')) {
  throw new Error('pre-summary must start at the prompt heading');
}
const PLACEHOLDERS = [
  'current_department', 'visit_type', 'safe_age', 'safe_dob', 'safe_gender',
  'safe_vitals', 'formatted_test_results', 'formatted_previous_visits', 'language_name',
];
const found = new Set([...preContent.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]));
for (const p of PLACEHOLDERS) if (!found.has(p)) throw new Error(`pre-summary lost placeholder ${p}`);
for (const p of found) if (!PLACEHOLDERS.includes(p)) throw new Error(`pre-summary has unexpected placeholder ${p}`);

// The five FORMAT titles are a parsing contract (PRE_SUMMARY_DISPLAY_TITLES).
const FORMAT_TITLES = [
  'Confirmed & Provisional Diagnoses:',
  'Investigations (Latest Dept Note):',
  'Diagnostics & Trends:',
  'Plan of Care (Latest Dept Note):',
  'Medications Prescribed (Latest Dept Note):',
];
for (const t of FORMAT_TITLES) if (!preContent.includes(`- ${t}`)) throw new Error(`FORMAT title missing: ${t}`);

// v3 splits dating into provenance + event date; both forms must be taught.
for (const marker of ['(recorded ', 'Provenance date', 'Event date']) {
  if (!preContent.includes(marker)) throw new Error(`pre-summary missing dating rule marker: ${marker}`);
}

const entries = [
  ...Object.entries(BY_SECTION).map(([n, name]) => [name, bodies.get(Number(n))]),
  ['PRE_SUMMARY', preContent],
];
for (const [name, body] of entries) {
  if (body.includes('FILE METADATA') || body.includes('DO NOT PASTE INTO HOPE')) {
    throw new Error(`${name}: author FILE METADATA comment leaked into prompt body`);
  }
}

const header = `/**
 * VERBATIM v3 clinical prompt content.
 *
 * GENERATED, DO NOT HAND-EDIT. Source of truth: the client-supplied v3 corpus
 *   DEPARTMENT_PROMPTS_v3.md   (22 fenced \`\`\`text blocks, one per department x visit type)
 *   PRE_SUMMARY_PROMPT_v3.md   (the prompt body; the author-only HTML comment
 *     at the top of the source file is stripped and is never seeded)
 * plus INTEGRATION_NOTES_v3.md and PROMPT_REVIEW_FINDINGS.md, which explain what
 * each change fixes and what was deliberately left alone.
 *
 * These are the versionNumber = 3 snapshots of the SAME 23 templates seeded by
 * 07b-arcaai-clinical-templates.ts. The v1 and v2 bodies remain in
 * 07b-arcaai-clinical-content.ts and 07b-arcaai-clinical-content-v2.ts and stay
 * on disk and in the database as versionNumber 1 and 2 - v3 is added alongside,
 * never in place of, either.
 *
 * MEASURED, NOT ASSUMED: the 22 DEPARTMENT bodies below are BYTE-IDENTICAL to
 * their v2 counterparts. v3's own version-history table credits v3.0 with
 * rewriting RULE 6 for ASR terminology repair, but that text was already present
 * in the v2 corpus - only the surrounding documentation prose differs between
 * DEPARTMENT_PROMPTS_v2.md and _v3.md. The one genuinely new body is the
 * PRE-SUMMARY. They are all still seeded as versionNumber 3 because the corpus
 * ships as a MATCHED SET (INTEGRATION_NOTES_v3.md section 1): the department
 * prompts depend on the v3 pre-summary's \`(recorded DD-MMM-YYYY)\` stamp to tell
 * history from what was said today, so one uniform pin keeps the pair from being
 * rolled back independently. A seed test asserts this asymmetry so it cannot
 * drift unnoticed.
 *
 * What v3 changes on top of v2 (INTEGRATION_NOTES_v3.md section 3):
 * - the pre-summary is REBUILT after review against a real generated snapshot.
 *   Six defects fixed: dating is split into a PROVENANCE date (one per bullet,
 *   trailing \`(recorded DD-MMM-YYYY)\`) and an EVENT date (inline, verbatim,
 *   never reformatted), so an old result inside a recently-filed note can no
 *   longer read as new; each distinct diagnosis is stated once rather than once
 *   per encounter; already-administered interventions are captured as status-post
 *   entries; Investigations carries RESULTS only (ordered tests belong to Plan of
 *   Care); dose changes are shown against the previous dose so a steroid taper
 *   stays visible; vitals are filtered for significance and trends use the whole
 *   supplied series;
 * - the pre-summary is ENGLISH-ONLY. The {language_name} localization block is
 *   removed - it contradicted the dating rule (it instructed the model to
 *   translate \`(date not stated)\`) and was dead code, since the caller hardcodes
 *   language 'en'. The PLACEHOLDER IS RETAINED and explicitly neutralised in the
 *   prompt text, so the nine-variable contract with renderPreSummaryTemplate is
 *   unchanged and nothing downstream breaks;
 * - RULE 6 now REQUIRES ASR terminology repair of mangled names (the client
 *   request - "shell cal" -> Shelcal), through a four-condition gate, always
 *   annotated \`(transcribed as "...")\`, with numbers, doses, dates, laterality
 *   and site still frozen. Extraction asserts the annotation form survives in all
 *   22 bodies: it is the entire safety argument for permitting repair, and must
 *   not be stripped for readability downstream;
 * - Hematology is re-worked against the department's own templates: Patient
 *   Details gains UHID, and heading 2 of Revisit is
 *   "Diagnoses & Co-morbidities" -> "Primary Diagnosis / Co-morbidities". That
 *   rename is the ONLY heading change in the corpus - verify the EMR section
 *   mapping for Hematology - Revisit before promoting past dev;
 * - Surgery - New/Referral is a genuinely new prompt (v1 numbered sections 1-21
 *   but shipped only Surgery - Follow-up, leaving new surgical patients with no
 *   matching prompt). It occupies the same template slot v2 introduced.
 *
 * Block A (\`=== SOURCE-OF-TRUTH PROTOCOL ===\`) and the per-heading \`SOURCE:\`
 * lines carry over from v2; extraction re-asserts all 22 copies of Block A are
 * byte-identical.
 *
 * Headings, sub-headings, ordering and numbering are otherwise unchanged - they
 * are the EMR's section keys, not prose.
 *
 * PRE_SUMMARY keeps the nine single-brace placeholders ({current_department},
 * {visit_type}, {safe_age}, {safe_dob}, {safe_gender}, {safe_vitals},
 * {formatted_test_results}, {formatted_previous_visits}, {language_name}) - the
 * source markdown escapes them as \`{current\\_department}\`, and extraction strips
 * those escapes, asserting all nine survive and no tenth appears. They are
 * substituted at ASSEMBLY time by \`renderPreSummaryTemplate\`
 * (apps/api .../smr-compat/summary-prompt.builder.ts), never here.
 *
 * The FORMAT block's five section titles are unchanged and are asserted present
 * at extraction: they are title-matched by \`PRE_SUMMARY_DISPLAY_TITLES\`
 * (apps/api .../smr-compat/summary-response.mapper.ts), and editing one without
 * the other returns an EMPTY structured_data.sections.
 *
 * Strings are JSON-encoded so backticks / \${...} in the source need no escaping.
 */
`;

const out = header + entries
  .map(([name, body]) => `\nexport const ${name}_CONTENT_V3: string =\n  ${JSON.stringify(body)};\n`)
  .join('');

writeFileSync(process.argv[2], out);
console.log(`wrote ${entries.length} bodies, ${out.length} bytes`);
