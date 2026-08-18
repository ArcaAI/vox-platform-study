/**
 * TASK-710 — Grep-gate: every NLP egress in `packages/applications` is redacted.
 *
 * The permanence mechanism for this ticket's re-opened finding (A-02). TASK-710
 * originally wired hop 1 into `consultation/jobs/processors/ner.processor.ts`;
 * TASK-732 deleted that file and the redaction went with it, leaving
 * `SummaryService.extractEntities()` posting `contextItem.content` to
 * `apps/nlp` RAW for an entire sprint without a single test noticing.
 *
 * A unit test on one call site cannot catch that class of regression, because
 * the regression is a NEW or MOVED call site. This gate scans SOURCE with
 * `node:fs` (never imports, so a bypass is caught even when it compiles) and
 * fails when a live-code NLP call site is not demonstrably redacted.
 *
 * Modelled on `legacy-generator-absent.grep-gate.test.ts` (TASK-732 Task 13),
 * which is itself modelled on TASK-704 Task 6 — same file-walk, same
 * comment-stripping, same "every assertion names its ticket" convention.
 *
 * Scope: `packages/applications/src`, excluding `__tests__/**` (fixtures
 * legitimately post fake text to fake URLs and are not the surface this
 * protects).
 *
 * The allow-list below is the load-bearing part: a file may only appear in it
 * with a written reason, so ADDING an unredacted egress requires editing this
 * gate — which is exactly the review moment that was missing when TASK-732
 * removed the redaction hop.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APPLICATIONS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * NLP endpoints that carry FREE TEXT out of this process. `/api/v1/extract`
 * (OCR) is deliberately absent — it posts an uploaded FILE (multipart), not
 * consultation text, and redaction of an image/PDF is a different problem with
 * a different owner.
 */
const NLP_TEXT_ENDPOINT = /api\/v1\/classify\/(tokens|topic|intent)/;

/**
 * Files allowed to reach an NLP text endpoint without an in-file redaction
 * call. Every entry needs a reason; an entry without one is a bug in this gate.
 */
const ALLOWED: Array<{ file: string; reason: string }> = [
  {
    file: 'services/consultation/shared/resolveNerModelSelection.ts',
    reason: 'resolves the AiTaskDefault model id only — mentions the endpoint in a doc comment, never posts text',
  },
  {
    file: 'services/consultation/live-documentation/live-tool-registry.ts',
    reason:
      'live SSE loop. Explicitly OUT of TASK-710 scope (§1: the live-documentation loop is not a redaction hop — it is the tightest latency budget in the system). Tracked separately; NOT a silent omission.',
  },
  {
    file: 'services/consultation/live-documentation/live-documentation.service.ts',
    reason: 'same live SSE loop as above — constructs the tool in `live-tool-registry.ts`; doc comments only',
  },
  {
    file: 'services/consultation/live-documentation/dto/live-summary.dto.ts',
    reason: 'response DTO — names the endpoint in a doc comment, posts nothing',
  },
  {
    file: 'services/consultation/live-documentation/live-documentation.service.module.ts',
    reason: 'module wiring — names the endpoint in a doc comment, posts nothing',
  },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip block and line comments so matches fire on LIVE CODE only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = listTsFiles(APPLICATIONS_SRC);

describe('TASK-710 — no unredacted NLP egress (grep-gate)', () => {
  it('sanity: the scanned tree is not empty', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every live-code NLP text call site redacts first (or is explicitly allow-listed)', () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const rel = relative(APPLICATIONS_SRC, file);
      if (!NLP_TEXT_ENDPOINT.test(stripped)) continue;
      if (ALLOWED.some((a) => a.file === rel)) continue;
      // A compliant call site names the redactor port in the SAME file — the
      // redaction and the egress must be reviewable together.
      if (/phiRedactor/.test(stripped)) continue;

      stripped.split('\n').forEach((lineText, idx) => {
        if (NLP_TEXT_ENDPOINT.test(lineText)) violations.push({ file: rel, line: idx + 1, text: lineText.trim() });
      });
    }

    expect(
      violations,
      `TASK-710: an NLP text endpoint is reached from a file that never calls \`phiRedactor\`. ` +
        `PHI must be redacted before it leaves this process (finding A-02). Either inject \`IPhiRedactor\` ` +
        `and redact, or add the file to this gate's ALLOWED list WITH A REASON:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('SummaryService.extractEntities — the hop TASK-732 re-opened — redacts before calling NLP', () => {
    const source = stripComments(readFileSync(resolve(APPLICATIONS_SRC, 'services', 'consultation', 'summary', 'summary.service.ts'), 'utf8'));

    expect(source, "extractEntities must post the redacted text, never contextItem.content").not.toMatch(
      /callNlpService\(\s*contextItem\.content\s*\)/,
    );
    expect(source, 'the pseudonymize call must be present').toMatch(/phiRedactor\.redact\([^)]*'pseudonymize'\)/);
  });

  it('the PHI redactor dependencies are NOT @Optional() on either wired hop (owner directive D-A)', () => {
    const hops = [
      { file: 'services/consultation/summary/summary.service.ts', hop: 'hop 1 — transcript → NLP' },
      { file: 'services/dna-writing-style/dna-writing-style.processor.ts', hop: 'hop 2 — DNA corpus → Text' },
    ];

    const violations = hops.filter(({ file }) => {
      const source = stripComments(readFileSync(resolve(APPLICATIONS_SRC, file), 'utf8'));
      return /@Optional\(\)\s*@Inject\(IPhiRedactor\)/.test(source);
    });

    expect(
      violations,
      `TASK-710 / D-A: a PHI redactor injected with @Optional() degrades SILENTLY to unredacted egress when the ` +
        `module graph loses \`PhiRedactionServiceModule\`. Inject it as a REQUIRED dependency so DI fails loudly ` +
        `instead:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('every module whose provider injects IPhiRedactor imports PhiRedactionServiceModule', () => {
    const modules = [
      'services/consultation/summary/summary.service.module.ts',
      'services/dna-writing-style/dna-writing-style.service.module.ts',
      'services/gate-edit-mining/gate-edit-mining.service.module.ts',
    ];

    const missing = modules.filter((rel) => !/PhiRedactionServiceModule/.test(stripComments(readFileSync(resolve(APPLICATIONS_SRC, rel), 'utf8'))));

    expect(missing, `TASK-710: these modules provide a service that injects IPhiRedactor but do not import its module:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });
});
