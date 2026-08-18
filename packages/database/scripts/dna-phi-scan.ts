// READ-ONLY DNA PHI scan CLI (TASK-700 Task 6).
//
// Decrypts every `DnaWritingStyleReport.styleText` row for a given tenant
// in-memory and runs a heuristic scan for PHI-shaped content, WITHOUT going
// through the running API. Reuses `decrypt-row.ts`'s Vault Transit wiring
// (`authenticateVaultClient`, `transitDecrypt`) and its `MODEL_REGISTRY` field
// spec for `DnaWritingStyleReport` rather than re-implementing decryption.
//
// This is the human-gated instrument for the assessment's "one query decides
// it" question (docs/architecture/consultation-session-workflow/assessment/
// README.md §3.2): clean rows mean the containment fix in this ticket already
// closes the forward-going path (a latent control gap); any dirty row means a
// LIVE incident requiring separate incident-response handling — out of this
// ticket's scope.
//
// STRICTLY READ-ONLY: only `findMany`/`findUnique` are ever called — no
// create/update/delete. Decrypted plaintext NEVER touches disk or stdout —
// only per-row, per-category MATCH COUNTS are printed (mirrors decrypt-row.ts's
// "ciphertext / secrets are never printed" discipline, extended to "matched PHI
// excerpts are never printed either").
//
// Usage:
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database dna:phi-scan -- --tenantId <arcaai-tenant-id> [--json]
//
// Exit codes:
//   0 — success (or --help)
//   1 — runtime error (Vault transit error, DB error, etc)
//   2 — bad invocation (missing/unknown args, wrong SECRETS_PROVIDER)
//
// EXECUTION IS HUMAN-GATED — see the ticket README (Task 6). This script is
// authored and unit-tested (pure heuristics only) but is NOT run as part of
// this ticket's automated completion.

// eslint-disable-next-line no-restricted-imports -- allow-list: scripts/ legitimately bypass tenant-scope for read-only admin tasks
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client.js';
import {
  MODEL_REGISTRY,
  decryptField,
  authenticateVaultClient,
  transitDecrypt,
  type DecryptFn,
  type VaultClientLike,
  type ParsedArgs,
} from './decrypt-row.js';
import vault from 'node-vault';

// ───────────────────────────── pure scan heuristics ─────────────────────────

/** Per-category match COUNTS only — never the matched substring or the source text. */
export interface ScanCounts {
  mrnShaped: number;
  dobShaped: number;
  drugDoseCoOccurrence: number;
  nameProxy: number;
}

export const EMPTY_SCAN_COUNTS: ScanCounts = { mrnShaped: 0, dobShaped: 0, drugDoseCoOccurrence: 0, nameProxy: 0 };

/** `MRN`/`MRN#`/`MRN:` followed by a run of digits. */
const MRN_PATTERN = /\bMRN[\s:#-]*\d{3,}\b/gi;

/** A `DOB`/`date of birth` label followed by a date, OR a bare date shape on its own. */
const DOB_PATTERN = /\b(?:DOB|D\.O\.B\.?|date of birth)[\s:]*\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b|\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b|\b(19|20)\d{2}-\d{2}-\d{2}\b/gi;

/**
 * A short, hand-authored list of common generic drug names for the
 * dose-co-occurrence heuristic. Narrow by design (this is a cheap, targeted
 * scan, not a general PHI redactor — that is TASK-710, out of scope here).
 */
export const KNOWN_DRUG_NAMES: readonly string[] = [
  'metformin',
  'lisinopril',
  'atorvastatin',
  'amoxicillin',
  'ibuprofen',
  'acetaminophen',
  'paracetamol',
  'omeprazole',
  'levothyroxine',
  'albuterol',
  'salbutamol',
  'metoprolol',
  'losartan',
  'gabapentin',
  'hydrochlorothiazide',
  'sertraline',
  'simvastatin',
  'amlodipine',
  'insulin',
  'warfarin',
  'prednisone',
  'azithromycin',
  'ciprofloxacin',
  'furosemide',
  'clopidogrel',
];

const DOSE_PATTERN = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|units?|iu)\b/i;
/** A dose mention within this many characters of a known drug name counts as co-occurring. */
const DOSE_PROXIMITY_WINDOW = 40;

/** Two capitalized words immediately after a name-introducing token (name proxy). */
const NAME_PROXY_PATTERN = /\b(?:Patient|Mr\.|Mrs\.|Ms\.|Dr\.)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g;

function countMatches(pattern: RegExp, text: string): number {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return (text.match(re) ?? []).length;
}

/**
 * Count drug-name + dose co-occurrences: a known drug name with a dose-shaped
 * token (`\d+\s?mg` etc.) within {@link DOSE_PROXIMITY_WINDOW} characters.
 * PURE, case-insensitive, counts non-overlapping drug mentions only.
 */
export function countDrugDoseCoOccurrence(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const drug of KNOWN_DRUG_NAMES) {
    let searchFrom = 0;
    for (;;) {
      const idx = lower.indexOf(drug, searchFrom);
      if (idx === -1) break;
      const windowStart = Math.max(0, idx - DOSE_PROXIMITY_WINDOW);
      const windowEnd = Math.min(text.length, idx + drug.length + DOSE_PROXIMITY_WINDOW);
      if (DOSE_PATTERN.test(text.slice(windowStart, windowEnd))) count++;
      searchFrom = idx + drug.length;
    }
  }
  return count;
}

/**
 * Run every heuristic category over a single decrypted `styleText` value.
 * PURE — no I/O. Returns COUNTS ONLY; callers must never log the input text
 * or any matched substring alongside these counts.
 */
export function scanText(text: string | null | undefined): ScanCounts {
  if (!text) return { ...EMPTY_SCAN_COUNTS };
  return {
    mrnShaped: countMatches(MRN_PATTERN, text),
    dobShaped: countMatches(DOB_PATTERN, text),
    drugDoseCoOccurrence: countDrugDoseCoOccurrence(text),
    nameProxy: countMatches(NAME_PROXY_PATTERN, text),
  };
}

/**
 * Character count of the decrypted value that was actually scanned. PURE.
 *
 * A row whose `styleText` decrypted to nothing produces the same all-zero
 * {@link ScanCounts} as a row that was scanned in full and found clean — so a
 * bare "CLEAN" verdict is ambiguous on its own. This length is reported
 * alongside the counts so a reader can tell "scanned N characters, found
 * nothing" from "there was nothing to scan". It is a LENGTH only: it never
 * exposes the text or any substring of it.
 */
export function scannedLength(text: string | null | undefined): number {
  return text ? text.length : 0;
}

export function isClean(counts: ScanCounts): boolean {
  return counts.mrnShaped === 0 && counts.dobShaped === 0 && counts.drugDoseCoOccurrence === 0 && counts.nameProxy === 0;
}

// ───────────────────────────────── CLI args ──────────────────────────────────

export interface ScanArgs {
  help: boolean;
  json: boolean;
  tenantId: string | null;
  transitMount: string;
  transitKey: string;
}

/** Parse `--k=v` and `--k v` forms + boolean `--flag`. PURE — mirrors decrypt-row.ts's parseArgs. */
export function parseScanArgs(argv: string[]): ScanArgs {
  const map = new Map<string, string>();
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) continue;
    const body = tok.replace(/^--/, '');
    if (body.includes('=')) {
      const [k, v = ''] = body.split('=');
      map.set(k, v);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      map.set(body, next);
      i++;
    } else {
      map.set(body, '');
    }
  }
  return {
    help: map.has('help') || map.has('h'),
    json: map.has('json'),
    tenantId: map.get('tenantId') || map.get('tenant-id') || null,
    transitMount: map.get('transit-mount') || 'transit',
    transitKey: map.get('transit-key') || 'hope-phi',
  };
}

export function validateScanInvocation(args: ScanArgs, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; code: number; message: string } {
  if (env.SECRETS_PROVIDER !== 'vault') {
    return { ok: false, code: 2, message: 'SECRETS_PROVIDER=vault is required (this tool decrypts real PHI via Vault Transit).' };
  }
  if (!args.tenantId) return { ok: false, code: 2, message: '--tenantId <tenantId> is required (see --help).' };
  return { ok: true };
}

// ───────────────────────────────── output ────────────────────────────────────

export interface RowScanResult {
  id: string;
  tenantId: string;
  doctorId: string;
  /** Characters of decrypted `styleText` actually scanned. 0 = nothing to scan. */
  scannedChars: number;
  counts: ScanCounts;
  clean: boolean;
}

function printUsage(): void {
  console.log(
    [
      "dna-phi-scan — READ-ONLY heuristic scan of a tenant's DnaWritingStyleReport.styleText rows for PHI-shaped content.",
      '',
      'Usage:',
      '  pnpm --filter @arcaai/database dna:phi-scan -- --tenantId <tenantId> [--json]',
      '',
      'Required env:',
      '  SECRETS_PROVIDER=vault   VAULT_ADDR   VAULT_ROLE_ID',
      '  VAULT_WRAPPED_SECRET_ID (preferred) or VAULT_SECRET_ID',
      '',
      'Options:',
      '  --tenantId   Tenant id to scan (uuid).',
      '  --json       Emit results as a JSON array to stdout.',
      '  --help       Show this help.',
      '',
      'Output is row id, tenant id, doctor id, and PER-CATEGORY MATCH COUNTS only —',
      'the decrypted text and any matched substring are never printed.',
      '',
      'Read-only: only findMany/findUnique are called.',
    ].join('\n'),
  );
}

function printResults(results: RowScanResult[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) {
    console.log(
      `${r.scannedChars === 0 ? 'EMPTY' : r.clean ? 'CLEAN' : 'DIRTY'}  id=${r.id} tenantId=${r.tenantId} doctorId=${r.doctorId} ` +
        `scannedChars=${r.scannedChars} mrnShaped=${r.counts.mrnShaped} dobShaped=${r.counts.dobShaped} ` +
        `drugDoseCoOccurrence=${r.counts.drugDoseCoOccurrence} nameProxy=${r.counts.nameProxy}`,
    );
  }
  const dirty = results.filter((r) => !r.clean).length;
  const empty = results.filter((r) => r.scannedChars === 0).length;
  const scannedChars = results.reduce((sum, r) => sum + r.scannedChars, 0);
  console.log(
    `\n${results.length} row(s) scanned — ${dirty} dirty, ${results.length - dirty} clean ` +
      `(${empty} of which decrypted to nothing and therefore prove nothing). ` +
      `${scannedChars} character(s) of decrypted styleText examined in total.`,
  );
}

// ───────────────────────────────── main ───────────────────────────────────────

interface DnaReportRow {
  id: string;
  tenantId: string;
  doctorId: string;
  // No plaintext `styleText` column exists (dropped — ciphertext-only, see
  // `dna-writing-style.prisma`); `decryptField` reads `encryptedStyleText` and
  // falls back to a `styleText` key that Prisma will simply never populate.
  encryptedStyleText: Buffer | Uint8Array | null;
}
interface PrismaLike {
  dnaWritingStyleReport: {
    findMany(args: { where: { tenantId: string } }): Promise<DnaReportRow[]>;
  };
  $disconnect(): Promise<void>;
}

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseScanArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }

  const ok = validateScanInvocation(args, env);
  if (!ok.ok) {
    console.error(ok.message);
    process.exitCode = ok.code;
    return;
  }

  const client = vault({ apiVersion: 'v1', endpoint: env.VAULT_ADDR }) as unknown as VaultClientLike;
  await authenticateVaultClient(client);
  // `transitDecrypt` only reads `transitMount`/`transitKey` off its `args`
  // parameter — build a minimally-populated `ParsedArgs` rather than widening
  // its signature just for this second caller.
  const transitArgs: ParsedArgs = {
    help: false,
    json: false,
    model: null,
    id: null,
    field: null,
    transitMount: args.transitMount,
    transitKey: args.transitKey,
  };
  const decrypt: DecryptFn = (ct) => transitDecrypt(client, transitArgs, ct);

  const styleTextSpec = MODEL_REGISTRY.DnaWritingStyleReport.fields.find((f) => f.plaintext === 'styleText')!;

  const prisma = getPlatformAdminPrismaClient_Unscoped() as unknown as PrismaLike;
  try {
    // Listing ids (+ tenant/doctor scope columns) is not itself a PHI read —
    // only `encryptedStyleText`/`styleText` are decrypted below, in-memory,
    // per row.
    const rows = await prisma.dnaWritingStyleReport.findMany({ where: { tenantId: args.tenantId! } });

    const results: RowScanResult[] = [];
    for (const row of rows) {
      const decrypted = await decryptField(row as unknown as Record<string, unknown>, styleTextSpec, decrypt);
      const value = typeof decrypted.value === 'string' ? decrypted.value : null;
      const counts = scanText(value);
      results.push({
        id: row.id,
        tenantId: row.tenantId,
        doctorId: row.doctorId,
        scannedChars: scannedLength(value),
        counts,
        clean: isClean(counts),
      });
    }

    printResults(results, args.json);
  } finally {
    await prisma.$disconnect();
  }
}

// Main-module guard so unit tests can import the pure helpers without running.
const invokedDirectly = typeof process.argv[1] === 'string' && /dna-phi-scan/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    // Log ONLY the message — node-vault can embed the (PHI) response body in the
    // error chain. DECRYPT_DEBUG=1 prints the full stack (never in production).
    const e = err as Error & { code?: string };
    console.error(`dna-phi-scan error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    if (process.env.DECRYPT_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
