import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/taphuynh/Downloads/v2';
const dept = readFileSync(`${SRC}/DEPARTMENT_PROMPTS_v2.md`, 'utf8');
const pre = readFileSync(`${SRC}/PRE_SUMMARY_PROMPT_v2.md`, 'utf8');

// md section number -> export base name (file order != section order)
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

// Block A must be byte-identical across all 22 (the findings doc's own invariant).
const blockA = new Set();
for (const body of bodies.values()) {
  const m = /=== SOURCE-OF-TRUTH PROTOCOL[\s\S]*?=== END SOURCE-OF-TRUTH PROTOCOL ===/.exec(body);
  if (!m) throw new Error('missing Block A');
  blockA.add(m[0]);
}
if (blockA.size !== 1) throw new Error(`Block A has ${blockA.size} variants, expected 1`);

// Pre-summary: whole document, markdown escapes removed so {placeholders} survive.
const preContent = pre.replace(/\\([*_])/g, '$1');
if (/\\/.test(preContent)) throw new Error('residual backslash in pre-summary');
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

const entries = [
  ...Object.entries(BY_SECTION).map(([n, name]) => [name, bodies.get(Number(n))]),
  ['PRE_SUMMARY', preContent],
];

const header = `/**
 * VERBATIM v2 clinical prompt content ("hardened" prompt set).
 *
 * GENERATED, DO NOT HAND-EDIT. Source of truth: the client-supplied v2 corpus
 *   DEPARTMENT_PROMPTS_v2.md   (22 fenced \`\`\`text blocks, one per department x visit type)
 *   PRE_SUMMARY_PROMPT_v2.md   (the whole document)
 * plus the rationale in PROMPT_REVIEW_FINDINGS.md, which explains what each
 * change fixes and what was deliberately left alone.
 *
 * These are the versionNumber = 2 snapshots of the SAME 23 templates seeded by
 * 07b-arcaai-clinical-templates.ts. The v1 bodies remain in
 * 07b-arcaai-clinical-content.ts and stay on disk and in the database as
 * versionNumber = 1 - v2 is added alongside, never in place of, v1.
 *
 * What v2 changes (summary; see PROMPT_REVIEW_FINDINGS.md for the full argument):
 * - every prompt carries a byte-identical \`=== SOURCE-OF-TRUTH PROTOCOL ===\`
 *   block (Block A) fixing the reported defect where prior case-note content was
 *   laundered into the note as if it had been said today. Extraction asserts
 *   all 22 copies are identical;
 * - every heading gains an explicit \`SOURCE:\` line (today's transcript only, vs
 *   prior record permitted with a mandatory inline date);
 * - RULE 6 permits ASR terminology repair of NAMES only - every number, dose,
 *   date, laterality and site is frozen, and each repair must carry its
 *   \`(transcribed as "...")\` annotation;
 * - non-executable instructions ("Log the summary to console") removed, and the
 *   Nephrology "do not suppress sections" contradiction harmonised;
 * - the pre-summary now dates every bullet, forbids inference and placeholders,
 *   and stays strictly literal (its input is typed EMR text, not audio, so the
 *   RULE 6 repair licence deliberately does NOT apply to it).
 *
 * Headings, sub-headings, ordering and numbering are unchanged from v1 except
 * the one rename the department's own template mandates: Hematology - Revisit
 * heading 2, "Primary Diagnoses & Co-morbidities" -> "Primary Diagnosis /
 * Co-morbidities" (PROMPT_REVIEW_FINDINGS.md section 5.2). Verify the EMR
 * section mapping for that heading before promoting this seed past dev.
 *
 * PRE_SUMMARY keeps v1's nine single-brace placeholders ({current_department},
 * {visit_type}, {safe_age}, {safe_dob}, {safe_gender}, {safe_vitals},
 * {formatted_test_results}, {formatted_previous_visits}, {language_name}) - the
 * source markdown escapes them as \`{current\\_department}\`, and extraction strips
 * those escapes, asserting all nine survive and no tenth appears. They are
 * substituted at ASSEMBLY time by \`renderPreSummaryTemplate\`
 * (apps/api .../smr-compat/summary-prompt.builder.ts), never here.
 *
 * The FORMAT block's five section titles are unchanged from v1 and are asserted
 * present at extraction: they are title-matched by \`PRE_SUMMARY_DISPLAY_TITLES\`
 * (apps/api .../smr-compat/summary-response.mapper.ts), and editing one without
 * the other returns an EMPTY structured_data.sections.
 *
 * Strings are JSON-encoded so backticks / \${...} in the source need no escaping.
 */
`;

const out = header + entries
  .map(([name, body]) => `\nexport const ${name}_CONTENT_V2: string =\n  ${JSON.stringify(body)};\n`)
  .join('');

writeFileSync(process.argv[2], out);
console.log(`wrote ${entries.length} bodies, ${out.length} bytes`);
