/**
 * Verify that every constant the guides quote still exists in the code.
 *
 * `docs/guides/*.md` tell an integrator which scope to ask for, which refusal code to branch on
 * and which SDK method to call. Each of those is a VALUE somewhere in this repo, so a rename is a
 * silent lie in the guide unless something compares the two. This is that something.
 *
 * Three checks, over fenced code blocks only (prose is allowed to paraphrase):
 *
 * | Token shape | Must be |
 * |---|---|
 * | `consultation:session:read`, `svc:workflow:run:write` | a key of the API-key or service-account scope registry, or a preset scope |
 * | `WORKFLOW_CONTEXT_INCOMPATIBLE` on a line that also mentions a refusal | a member of `OPEN_REFUSAL_CODES`, or `SCHEMA_IMPACT_UNACKNOWLEDGED` |
 * | `hope.consultations.listContext` | a real property path on a live `HopeClient` |
 *
 * Plus one check in the other direction, over the whole guide set rather than its fenced blocks:
 * every refusal code and every preset scope the code declares must be MENTIONED somewhere. That is
 * what catches a code added to the union — or a scope added to a preset — that the guides never
 * learned about, which no amount of checking what is already written can find.
 *
 * Sources are imported from TypeScript SOURCE, not from `dist`: `pnpm verify` runs lint,
 * typecheck and test without building anything, so a `dist`-based check would be red on a clean
 * tree. `tsx` loads the source directly, and the SDK surface is then walked on a real client
 * instance rather than parsed out of it.
 *
 *   pnpm docs:check           fail on the first miss, listing every one
 *   pnpm docs:check --list    also print every token that was checked
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { API_KEY_SCOPE_PRESETS, OPEN_REFUSAL_CODES } from '../packages/types/src/index';
import { API_KEY_SCOPE_REGISTRY } from '../packages/applications/src/services/apiKey/apikey-scopes.registry';
import { SERVICE_ACCOUNT_SCOPE_REGISTRY } from '../packages/applications/src/services/serviceAccount/service-account-scopes.registry';
import { HopeClient } from '../packages/vox-node/src/index';

const GUIDES_DIR = resolve(import.meta.dirname, '../docs/guides');

/** A scope-shaped token: `a:b`, `a:b:c`, or the service-account `svc:a:b:c`. */
const SCOPE_TOKEN = /^(?:svc:)?[a-z][a-z-]*:[a-z][a-z-]*(?::[a-z][a-z-]*)?$/;
/** SCREAMING_SNAKE with at least two words. */
const CODE_TOKEN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** `hope.<resource>.<method>` — up to two nested namespaces (`hope.consultations.streams.liveSummary`). */
const SDK_CALL = /\bhope((?:\.[a-zA-Z][a-zA-Z0-9]*){2,3})\b/g;

/** The publish gate's code is documented beside the refusals but is not one of them. */
const EXTRA_CODES = new Set(['SCHEMA_IMPACT_UNACKNOWLEDGED']);

export interface DocsCheckReport {
  files: string[];
  scopes: string[];
  codes: string[];
  calls: string[];
  /** Declared constants no guide mentions at all. */
  undocumented: string[];
  failures: string[];
}

/** Every fenced block's body, with the ``` lines dropped. */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (current === null) current = [];
      else {
        blocks.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    current?.push(line);
  }
  return blocks;
}

/** Strip the punctuation a token picks up from prose, markdown and code. */
function bare(token: string): string {
  return token.replace(/^[`'"([{<|,.;]+/, '').replace(/[`'"),\]}>|.;:]+$/, '');
}

/**
 * A SCREAMING_SNAKE token is read as a refusal code only when its line is ABOUT one — otherwise
 * every env var and enum member in a snippet would be judged against the refusal union. Anything
 * the union itself exports (`OPEN_REFUSAL_CODES`) is a name, not a code.
 */
function looksLikeRefusalCode(token: string, line: string): boolean {
  if (!CODE_TOKEN.test(token)) return false;
  if (token.startsWith('HOPE_') || token.endsWith('_CODES') || token.endsWith('_PRESETS')) return false;
  if (new RegExp(`(?:^|[^A-Z_])${token}\\s*=`).test(line)) return false; // FOO=bar, an env assignment
  return /\bcode\b|\brefus|\b4\d\d\b/i.test(line);
}

export function knownScopes(): Set<string> {
  const scopes = new Set<string>([...Object.keys(API_KEY_SCOPE_REGISTRY), ...Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY)]);
  for (const preset of API_KEY_SCOPE_PRESETS) for (const scope of preset.scopes) scopes.add(scope);
  return scopes;
}

/** Resolve `.a.b.c` against a live client; `null` when any step is missing. */
export function resolvesOnClient(path: string, client: object): boolean {
  let cursor: unknown = client;
  for (const step of path.split('.').filter(Boolean)) {
    if (cursor === null || (typeof cursor !== 'object' && typeof cursor !== 'function')) return false;
    if (!(step in (cursor as object))) return false;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor !== undefined;
}

export function checkDocsConstants(files: { name: string; contents: string }[], client: object): DocsCheckReport {
  const scopes = knownScopes();
  const codes = new Set<string>([...OPEN_REFUSAL_CODES, ...EXTRA_CODES]);
  const report: DocsCheckReport = { files: files.map((f) => f.name), scopes: [], codes: [], calls: [], undocumented: [], failures: [] };

  for (const { name, contents } of files) {
    for (const block of fencedBlocks(contents)) {
      for (const line of block.split('\n')) {
        for (const raw of line.split(/\s+/)) {
          const token = bare(raw);
          if (SCOPE_TOKEN.test(token)) {
            report.scopes.push(token);
            if (!scopes.has(token)) report.failures.push(`${name}: scope \`${token}\` is in no scope registry and in no preset`);
          } else if (looksLikeRefusalCode(token, line)) {
            report.codes.push(token);
            if (!codes.has(token)) report.failures.push(`${name}: \`${token}\` reads as a refusal code but is not in OPEN_REFUSAL_CODES`);
          }
        }
      }
      for (const [, path] of block.matchAll(SDK_CALL)) {
        report.calls.push(`hope${path}`);
        if (!resolvesOnClient(path, client)) report.failures.push(`${name}: \`hope${path}\` does not resolve on the vox-node HopeClient surface`);
      }
    }
  }

  const everything = files.map((f) => f.contents).join('\n');
  for (const declared of [...OPEN_REFUSAL_CODES, ...API_KEY_SCOPE_PRESETS.flatMap((preset) => preset.scopes)]) {
    if (!everything.includes(declared)) {
      report.undocumented.push(declared);
      report.failures.push(`the guides never mention \`${declared}\`, which the code declares`);
    }
  }
  return report;
}

function main(): void {
  const list = process.argv.includes('--list');
  const names = readdirSync(GUIDES_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const files = names.map((name) => ({ name, contents: readFileSync(resolve(GUIDES_DIR, name), 'utf8') }));
  const client = new HopeClient({ baseUrl: 'http://localhost', apiKey: 'docs-check' });
  const report = checkDocsConstants(files, client);

  const unique = (values: string[]): string[] => [...new Set(values)].sort();
  console.log(`[docs-check] ${report.files.length} guide(s): ${report.files.join(', ')}`);
  console.log(
    `  scopes ${unique(report.scopes).length} · refusal codes ${unique(report.codes).length} · SDK calls ${unique(report.calls).length} · declared constants unmentioned ${report.undocumented.length}`,
  );
  if (list) {
    for (const [label, values] of [
      ['scope', report.scopes],
      ['code', report.codes],
      ['call', report.calls],
    ] as const)
      for (const value of unique(values)) console.log(`    ${label}  ${value}`);
  }

  if (report.failures.length > 0) {
    console.error(`\n[docs-check] FAILED\n${report.failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log('\n[docs-check] OK — every scope, refusal code and SDK method the guides quote exists in the code.');
}

// Only run the CLI when invoked directly, so the test can import the checker.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  try {
    main();
  } catch (error) {
    console.error(`[docs-check] ${(error as Error).message}`);
    process.exit(1);
  }
}
