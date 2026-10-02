#!/usr/bin/env node
/**
 * TASK-1034 R3 content rollout — idempotent, through the ADMIN API only (no SQL, no seed run).
 * Modelled on the TASK-1020 rollout (`docs/implementation/TASK-1020-Consultation-Visit-Lifecycle-Single-And-Same-Day-Return/rollout.mjs`).
 *
 *   DRY_RUN=1 node docs/implementation/TASK-1034-DNA-Weekly-Regeneration-Ingest-And-Prompt-Rules/rollout.mjs
 *   node docs/implementation/TASK-1034-DNA-Weekly-Regeneration-Ingest-And-Prompt-Rules/rollout.mjs
 *
 * Applies, for one tenant (default ARCAAI):
 *   1. the CLINICIAN REDACTION RULES block (`{{context.dna_redaction_rules_text | default("")}}`
 *      under "Never include / always rewrite") on the ACTIVE `casenote-finalization` agent — the
 *      one every consultation graph's durable `n_finalize` runs. The block is taken from the
 *      committed seed (`25-agents.ts` `CASENOTE_FINALIZATION_SYSTEM_PROMPT`, evaluated with `tsx`)
 *      and INSERTED immediately before the `=== WRITING STYLE ===` heading of the agent's own
 *      base body, so any tenant edit to the rest of that body survives. Publish FREEZES fragment
 *      text into `compiledConfig`, so this is a republish (new version → PATCH → validate →
 *      publish + activate), exactly the TASK-1020 recipe.
 *
 * Idempotent: an agent whose base body already binds `dna_redaction_rules_text` AND whose
 * `compiledConfig` carries it is skipped. A base body that is a `promptTemplateId` (not inline),
 * or that has no `=== WRITING STYLE ===` anchor, is a FAIL (edit it by hand) — never a guess.
 *
 * NOT done here (deliberately): republishing the tenant's `consultation_note_context` schema with
 * the new declared field. Both lanes render the variable without it (the finalize binding carries
 * `default("")`, and the gateway lane appends the block itself); publish it with the schema
 * tooling when the tenant's schema is next updated.
 *
 * Env:
 *   HOPE_BASE_URL         default http://localhost:8868
 *   HOPE_ADMIN_USERNAME   default arcaai_admin
 *   HOPE_ADMIN_PASSWORD   required unless the base URL is localhost (then the seeded dev password). Never printed.
 *   HOPE_TENANT_KEY       default ARCAAI
 *   HOPE_TENANT_ID        default 50000000-0000-0000-0000-000000000001 (checked against the login)
 *   DRY_RUN=1             read-only: prints `plan` for every step that would write
 *   PUBLISH_SETTLE_MS     wait after a publish (default 15000; the per-process agent cache)
 *
 * Output: one line per step — `ok` / `skip` / `plan` / `FAIL`. Exit code 1 on any FAIL.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

const BASE = (process.env.HOPE_BASE_URL ?? 'http://localhost:8868').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const USERNAME = process.env.HOPE_ADMIN_USERNAME ?? 'arcaai_admin';
const TENANT_KEY = process.env.HOPE_TENANT_KEY ?? 'ARCAAI';
const TENANT_ID = process.env.HOPE_TENANT_ID ?? '50000000-0000-0000-0000-000000000001';
const DRY = process.env.DRY_RUN === '1';
const SETTLE_MS = Number(process.env.PUBLISH_SETTLE_MS ?? 15000);
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);

const FINALIZER_SLUG = 'casenote-finalization';
const BASE_KEY = 'clinical_note';
const RULES_HEADING = '=== CLINICIAN REDACTION RULES ===';
const STYLE_HEADING = '=== WRITING STYLE ===';
const MARKER = 'dna_redaction_rules_text';

let failures = 0;
const line = (status, step, detail = '') => console.log(`${status.padEnd(4)} ${step}${detail ? ` — ${detail}` : ''}`);
const ok = (s, d) => line('ok', s, d);
const skip = (s, d) => line('skip', s, d);
const plan = (s, d) => line('plan', s, d);
const fail = (s, d) => {
  failures += 1;
  line('FAIL', s, d);
};

// ---------------------------------------------------------------------------------------------
// Seed evaluation (tsx) — the committed seed is the source of truth for the block text
// ---------------------------------------------------------------------------------------------
function loadRulesBlock() {
  const tsx = resolve(REPO, 'node_modules/.bin/tsx');
  if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx} — run from a checkout with dependencies installed`);
  const seedDir = resolve(REPO, 'packages/database/src/prisma/db_main/seed');
  const code = `
    import(${JSON.stringify(`${seedDir}/25-agents.ts`)}).then((m) => {
      process.stdout.write('@@SEED@@' + JSON.stringify({ prompt: m.CASENOTE_FINALIZATION_SYSTEM_PROMPT }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(tsx, ['-e', code], { cwd: resolve(REPO, 'packages/database'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const at = out.lastIndexOf('@@SEED@@');
  if (at < 0) throw new Error('seed evaluation printed no payload');
  const { prompt } = JSON.parse(out.slice(at + '@@SEED@@'.length));
  const start = prompt.indexOf(RULES_HEADING);
  const end = prompt.indexOf(STYLE_HEADING);
  if (start < 0 || end < start) throw new Error('seed finalizer prompt carries no redaction-rules block before the style block');
  return prompt.slice(start, end); // ends with the blank line that separates it from the style block
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
let token = '';
function password() {
  const p = process.env.HOPE_ADMIN_PASSWORD;
  if (p) return p;
  if (IS_LOCAL) return 'password123'; // the seeded local demo password (packages/database seed 91-user.ts)
  throw new Error('HOPE_ADMIN_PASSWORD is required for a non-local HOPE_BASE_URL');
}

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: password(), tenantKey: TENANT_KEY }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`login failed: HTTP ${res.status}`);
  token = body.token;
  return body.user;
}

class HttpError extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} -> HTTP ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 1200));
    this.status = status;
    this.body = body;
  }
}

/** `ifMatch` is the row `version` (sent as the strong validator `"<version>"`). */
async function call(method, path, { body, ifMatch, retried = false } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
  const res = await fetch(`${API}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !retried) {
    await login();
    return call(method, path, { body, ifMatch, retried: true });
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new HttpError(res.status, method, path, parsed);
  return parsed;
}
const get = (p) => call('GET', p);
const rows = (r) => (Array.isArray(r) ? r : (r?.data ?? r?.items ?? []));

/** Depth-first: does any string inside `node` contain `needle`? Returns the JSON path or null. */
function findText(node, needle, path = '$') {
  if (typeof node === 'string') return node.includes(needle) ? path : null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const r = findText(node[i], needle, `${path}[${i}]`);
      if (r) return r;
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const r = findText(v, needle, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// the finalizer
// ---------------------------------------------------------------------------------------------
/** The base body with the rules block inserted before the style heading; `null` = no anchor. */
function withRulesBlock(body, block) {
  if (body.includes(MARKER)) return body;
  const at = body.indexOf(STYLE_HEADING);
  if (at < 0) return null;
  return body.slice(0, at) + block + body.slice(at);
}

/** `{ instruction, changed }` or `{ error }` — derived from what the agent carries now. */
function desiredInstruction(current, block) {
  if (Array.isArray(current?.fragments)) {
    const fragments = current.fragments.map((f) => ({ ...f }));
    const idx = Math.max(0, fragments.findIndex((f) => f.key === BASE_KEY));
    const base = fragments[idx];
    if (typeof base?.systemPrompt !== 'string') return { error: `base fragment \`${base?.key}\` is not inline (promptTemplateId) — edit it by hand` };
    const next = withRulesBlock(base.systemPrompt, block);
    if (next === null) return { error: `base fragment has no \`${STYLE_HEADING}\` anchor — edit it by hand` };
    fragments[idx] = { ...base, systemPrompt: next };
    return { instruction: { ...current, fragments }, changed: next !== base.systemPrompt };
  }
  if (typeof current?.systemPrompt === 'string' && current.systemPrompt) {
    const next = withRulesBlock(current.systemPrompt, block);
    if (next === null) return { error: `systemPrompt has no \`${STYLE_HEADING}\` anchor — edit it by hand` };
    return { instruction: { ...current, systemPrompt: next }, changed: next !== current.systemPrompt };
  }
  return { error: `cannot derive (instruction keys=${Object.keys(current ?? {})})` };
}

async function republish(step, active, instruction) {
  let draft = await call('POST', `admin/agents/${active.id}/versions`, { body: {} });
  draft = await call('PATCH', `admin/agents/${draft.id}`, { ifMatch: draft.version, body: { instruction } });
  const validated = await call('POST', `admin/agents/${draft.id}/validate`, { body: {} });
  if (validated.validationReport?.blocking) {
    fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
    return false;
  }
  const pub = await call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true } });
  const versions = await get(`admin/agents/${pub.id}/versions`);
  const activeCount = versions.filter((v) => v.isActive).length;
  const frozen = findText(pub.compiledConfig, MARKER);
  if (activeCount !== 1) fail(step, `${activeCount} active versions after publish`);
  else if (!frozen) fail(step, `published v${pub.versionNumber} but the block is not frozen into compiledConfig`);
  else ok(step, `v${active.versionNumber} -> v${pub.versionNumber} id=${pub.id} active=1 frozen at ${frozen}`);
  return true;
}

async function ensureFinalizer(block) {
  const step = `agent ${FINALIZER_SLUG}`;
  const list = (await get('admin/agents?task=TEXT_GENERATION')) ?? [];
  const actives = rows(list).filter((a) => a.slug === FINALIZER_SLUG && a.tenantId === TENANT_ID && a.isActive && a.status === 'PUBLISHED');
  if (actives.length !== 1) {
    fail(step, `expected 1 active published ${FINALIZER_SLUG} in the tenant, found ${actives.length}`);
    return 0;
  }
  const active = await get(`admin/agents/${actives[0].id}`);
  const derived = desiredInstruction(active.instruction, block);
  if (derived.error) {
    fail(step, derived.error);
    return 0;
  }
  const frozenAt = findText(active.compiledConfig, MARKER);
  if (!derived.changed && frozenAt) {
    skip(step, `v${active.versionNumber} active, block bound and frozen at ${frozenAt}`);
    return 0;
  }
  if (DRY) {
    plan(step, `v${active.versionNumber} -> v${active.versionNumber + 1}: insert=${derived.changed} frozen=${Boolean(frozenAt)}`);
    return 0;
  }
  return (await republish(step, active, derived.instruction)) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`TASK-1034 R3 rollout -> ${BASE} tenant=${TENANT_KEY}${DRY ? ' [DRY RUN]' : ''}`);
  const block = loadRulesBlock();
  const user = await login();
  if (user.tenantId !== TENANT_ID) throw new Error(`logged in to tenant ${user.tenantId}, expected ${TENANT_ID} (set HOPE_TENANT_ID)`);
  ok('login', `${USERNAME} tenant=${user.tenantId}`);

  let published = 0;
  try {
    published += await ensureFinalizer(block);
  } catch (e) {
    fail(`agent ${FINALIZER_SLUG}`, e.message);
  }
  if (published > 0 && SETTLE_MS > 0) {
    ok('agents settle', `waiting ${SETTLE_MS} ms for the per-process agent cache`);
    await sleep(SETTLE_MS);
  }
  console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps ok');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL fatal — ${e.message}`);
  process.exit(1);
});
