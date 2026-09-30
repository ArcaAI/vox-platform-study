#!/usr/bin/env node
/**
 * TASK-1022 content rollout — idempotent, through the ADMIN API only (no SQL, no seed run).
 *
 *   node docs/implementation/TASK-1022-Finalizer-Keeps-Template-Headings/rollout.mjs
 *
 * Republishes every `casenote-finalization` that froze the old finalization body, onto the seed's
 * `CASENOTE_FINALIZATION_SYSTEM_PROMPT` (the DOCUMENT HEADINGS block):
 *
 *   1. the TENANT finalizer (default ArcaAI — the agent every ArcaAI graph's `n_finalize` runs),
 *      as that tenant's admin;
 *   2. the GLOBAL build tenant's finalizer, as a super admin elevated into Global (`x-tenant-id`);
 *   3. the SYSTEM finalizer, by PROMOTING Global's active version (`POST admin/agents/promote-to-system`)
 *      as a super admin in a tenant-LESS context — rule 00 D-8: SYSTEM content is authored in Global
 *      and promoted, never edited in place. The promotion re-binds Global's policy template to
 *      SYSTEM's copy of the same name and publishes + activates the new SYSTEM version.
 *
 * The republish recipe is TASK-1020's (publish FREEZES fragment text into `compiledConfig`): new
 * version → PATCH the instruction under If-Match → validate → publish + activate → exactly one
 * active version → the new body is frozen into `compiledConfig`. Only the BASE fragment's inline
 * `systemPrompt` changes (the `clinical_note` fragment, else the first; a single-form
 * `systemPrompt` instruction likewise); every other fragment and instruction key is carried as-is.
 * A base bound to a `promptTemplateId` is not this rollout's to rewrite and is reported as FAIL.
 *
 * Idempotent: a step whose active version already carries the seed body AND has it frozen is `skip`.
 * The source of truth for the text is the committed seed (`packages/database/.../seed/25-agents.ts`),
 * evaluated with `tsx` so nothing is copied. Run from a checkout (`node_modules/.bin/tsx` must exist).
 *
 * Env:
 *   HOPE_BASE_URL               default http://localhost:8868
 *   HOPE_ADMIN_USERNAME         default arcaai_admin              (step 1)
 *   HOPE_ADMIN_PASSWORD         required unless the base URL is local (then the seeded dev password)
 *   HOPE_TENANT_KEY             default ARCAAI
 *   HOPE_TENANT_ID              default 50000000-0000-0000-0000-000000000001 (checked against the login)
 *   HOPE_SUPER_ADMIN_USERNAME   default super_admin               (steps 2-3; logs in with NO tenantKey)
 *   HOPE_SUPER_ADMIN_PASSWORD   required unless the base URL is local. Never printed.
 *   SKIP_TENANT=1               skip step 1
 *   SKIP_PLATFORM=1             skip steps 2-3
 *   DRY_RUN=1                   read-only: prints `plan` for every step that would write
 *   PUBLISH_SETTLE_MS           wait after the last publish (default 15000; the agent cache)
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
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);
const TENANT_USERNAME = process.env.HOPE_ADMIN_USERNAME ?? 'arcaai_admin';
const TENANT_KEY = process.env.HOPE_TENANT_KEY ?? 'ARCAAI';
const TENANT_ID = process.env.HOPE_TENANT_ID ?? '50000000-0000-0000-0000-000000000001';
const SUPER_USERNAME = process.env.HOPE_SUPER_ADMIN_USERNAME ?? 'super_admin';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DRY = process.env.DRY_RUN === '1';
const SKIP_TENANT = process.env.SKIP_TENANT === '1';
const SKIP_PLATFORM = process.env.SKIP_PLATFORM === '1';
const SETTLE_MS = Number(process.env.PUBLISH_SETTLE_MS ?? 15000);
const SLUG = 'casenote-finalization';
const CHANGE_REASON = 'TASK-1022 — the finalizer keeps the document template headings (DOCUMENT HEADINGS block)';

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
// Seed evaluation (tsx) — the committed seed is the source of truth
// ---------------------------------------------------------------------------------------------
function loadSeed() {
  const tsx = resolve(REPO, 'node_modules/.bin/tsx');
  if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx} — run from a checkout with dependencies installed`);
  const seedDir = resolve(REPO, 'packages/database/src/prisma/db_main/seed');
  const code = `
    import(${JSON.stringify(`${seedDir}/25-agents.ts`)}).then((a) => {
      process.stdout.write('@@SEED@@' + JSON.stringify({ body: a.CASENOTE_FINALIZATION_SYSTEM_PROMPT, baseKey: a.CLINICAL_NOTE_FRAGMENT_KEY }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(tsx, ['-e', code], { cwd: resolve(REPO, 'packages/database'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const at = out.lastIndexOf('@@SEED@@');
  if (at < 0) throw new Error('seed evaluation printed no payload');
  const seed = JSON.parse(out.slice(at + '@@SEED@@'.length));
  if (typeof seed.body !== 'string' || !seed.body.includes('{{trigger.context.document_headings')) {
    throw new Error('the seed finalization body does not bind document_headings — is this checkout on TASK-1022?');
  }
  return seed;
}

// ---------------------------------------------------------------------------------------------
// HTTP — one session per credential; `tenant` is the super admin's `x-tenant-id` elevation
// ---------------------------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} -> HTTP ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 1200));
    this.status = status;
    this.body = body;
  }
}

function passwordFor(envName) {
  const p = process.env[envName];
  if (p) return p;
  if (IS_LOCAL) return 'password123'; // the seeded local demo password (packages/database seed 91-user.ts)
  throw new Error(`${envName} is required for a non-local HOPE_BASE_URL`);
}

function session({ username, passwordEnv, tenantKey }) {
  let token = '';
  const login = async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: passwordFor(passwordEnv), ...(tenantKey ? { tenantKey } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(`login ${username} failed: HTTP ${res.status}`);
    token = body.token;
    return body.user;
  };
  /** `ifMatch` is the row `version` (sent as the strong validator `"<version>"`). */
  const call = async (method, path, { body, ifMatch, tenant, retried = false } = {}) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
    if (tenant) headers['x-tenant-id'] = tenant;
    const res = await fetch(`${API}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && !retried) {
      await login();
      return call(method, path, { body, ifMatch, tenant, retried: true });
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
  };
  return { login, call };
}

const rows = (r) => (Array.isArray(r) ? r : (r?.data ?? r?.items ?? []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------------------------------------------------------------------------------------------
// the instruction
// ---------------------------------------------------------------------------------------------
/**
 * The instruction with the BASE body replaced by the seed body, everything else carried.
 * `{ instruction, current }` — `current` is the base body it carries now — or `{ error }`.
 */
function desiredInstruction(current, seed) {
  if (Array.isArray(current?.fragments)) {
    const fragments = current.fragments.map((f) => ({ ...f }));
    if (fragments.length === 0) return { error: 'instruction has an empty fragments list' };
    const at = Math.max(
      0,
      fragments.findIndex((f) => f.key === seed.baseKey),
    );
    const base = fragments[at];
    if (typeof base.systemPrompt !== 'string') {
      return {
        error: `base fragment '${base.key}' is not an inline systemPrompt (promptTemplateId=${base.promptTemplateId ?? '-'}); rewrite it by hand`,
      };
    }
    fragments[at] = { ...base, systemPrompt: seed.body };
    return { instruction: { ...current, fragments }, current: base.systemPrompt };
  }
  if (typeof current?.systemPrompt === 'string' && current.systemPrompt) {
    return { instruction: { ...current, systemPrompt: seed.body }, current: current.systemPrompt };
  }
  return { error: `cannot find an inline base body; instruction keys=${Object.keys(current ?? {})}` };
}

/** Exactly one active PUBLISHED `casenote-finalization` in `tenantId`, read in full. */
async function activeFinalizer(api, tenantId, tenant) {
  const list = rows((await api.call('GET', 'admin/agents?task=TEXT_GENERATION', { tenant })) ?? []);
  const actives = list.filter((a) => a.slug === SLUG && a.tenantId === tenantId && a.isActive && a.status === 'PUBLISHED');
  if (actives.length !== 1) throw new Error(`expected 1 active published ${SLUG} in tenant ${tenantId}, found ${actives.length}`);
  return api.call('GET', `admin/agents/${actives[0].id}`, { tenant });
}

/** TASK-1020's republish recipe, parameterised by session and tenant elevation. */
async function republish(step, api, tenant, active, instruction, marker) {
  let draft = await api.call('POST', `admin/agents/${active.id}/versions`, { body: {}, tenant });
  draft = await api.call('PATCH', `admin/agents/${draft.id}`, { ifMatch: draft.version, body: { instruction }, tenant });
  const validated = await api.call('POST', `admin/agents/${draft.id}/validate`, { body: {}, tenant });
  if (validated.validationReport?.blocking) {
    fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
    return false;
  }
  const pub = await api.call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true }, tenant });
  const versions = await api.call('GET', `admin/agents/${pub.id}/versions`, { tenant });
  const activeCount = versions.filter((v) => v.isActive).length;
  const frozen = findText(pub.compiledConfig, marker);
  if (activeCount !== 1) fail(step, `${activeCount} active versions after publish`);
  else if (!frozen) fail(step, `published v${pub.versionNumber} but the new body is not frozen into compiledConfig`);
  else ok(step, `v${active.versionNumber} -> v${pub.versionNumber} id=${pub.id} active=1 frozen at ${frozen}`);
  return true;
}

/** Steps 1 and 2: one tenant's own finalizer. Returns 'published' | 'current' | 'planned' | 'failed'. */
async function ensureFinalizer(step, api, tenantId, tenant, seed) {
  const active = await activeFinalizer(api, tenantId, tenant);
  const derived = desiredInstruction(active.instruction, seed);
  if (derived.error) {
    fail(step, derived.error);
    return 'failed';
  }
  const frozenAt = findText(active.compiledConfig, seed.body);
  if (derived.current === seed.body && frozenAt) {
    skip(step, `v${active.versionNumber} active, seed body bound and frozen at ${frozenAt}`);
    return 'current';
  }
  if (DRY) {
    plan(step, `v${active.versionNumber} -> v${active.versionNumber + 1}: bodyCurrent=${derived.current === seed.body} frozen=${Boolean(frozenAt)}`);
    return 'planned';
  }
  return (await republish(step, api, tenant, active, derived.instruction, seed.body)) ? 'published' : 'failed';
}

/** Step 3: promote Global's active finalizer into SYSTEM (tenant-less), unless SYSTEM already has it. */
async function ensureSystem(step, api, seed, globalOutcome) {
  let system = null;
  try {
    system = await activeFinalizer(api, SYSTEM_TENANT_ID, SYSTEM_TENANT_ID);
  } catch (e) {
    // A SYSTEM read that cannot be made is not a reason to skip the promotion; it is reported.
    line('warn', step, `could not read the SYSTEM finalizer before promoting: ${e.message}`);
  }
  const frozenAt = system ? findText(system.compiledConfig, seed.body) : null;
  if (frozenAt) {
    skip(step, `SYSTEM v${system.versionNumber} active, seed body frozen at ${frozenAt}`);
    return false;
  }
  if (globalOutcome === 'failed') {
    fail(step, 'skipped: the Global step failed, and SYSTEM is promoted FROM Global');
    return false;
  }
  if (DRY) {
    plan(step, `promote Global's active ${SLUG} into SYSTEM (SYSTEM now v${system?.versionNumber ?? '?'}, frozen=false)`);
    return false;
  }
  // NO `tenant`: promotion requires an elevated, tenant-LESS super-admin context (403 otherwise).
  const res = await api.call('POST', 'admin/agents/promote-to-system', { body: { sourceSlug: SLUG, changeReason: CHANGE_REASON } });
  const after = await api.call('GET', `admin/agents/${res.agentId}`, { tenant: SYSTEM_TENANT_ID });
  const versions = await api.call('GET', `admin/agents/${res.agentId}/versions`, { tenant: SYSTEM_TENANT_ID });
  const activeCount = versions.filter((v) => v.isActive).length;
  const frozen = findText(after.compiledConfig, seed.body);
  if (!after.isActive || after.status !== 'PUBLISHED') fail(step, `promoted v${res.versionNumber} is ${after.status} active=${after.isActive}`);
  else if (activeCount !== 1) fail(step, `${activeCount} active SYSTEM versions after the promotion`);
  else if (!frozen) fail(step, `promoted v${res.versionNumber} but the new body is not frozen into compiledConfig`);
  else
    ok(
      step,
      `SYSTEM v${system?.versionNumber ?? '?'} -> v${res.versionNumber} id=${res.agentId} promotion=${res.promotionId} active=1 frozen at ${frozen}${res.warnings?.length ? ` warnings=${JSON.stringify(res.warnings)}` : ''}`,
    );
  return true;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`TASK-1022 rollout -> ${BASE}${DRY ? ' [DRY RUN]' : ''}`);
  const seed = loadSeed();
  ok('seed', `finalization body ${seed.body.length} chars, base fragment key '${seed.baseKey}'`);
  let published = 0;

  if (!SKIP_TENANT) {
    const step = `tenant ${TENANT_KEY} ${SLUG}`;
    try {
      const api = session({ username: TENANT_USERNAME, passwordEnv: 'HOPE_ADMIN_PASSWORD', tenantKey: TENANT_KEY });
      const user = await api.login();
      if (user.tenantId !== TENANT_ID) throw new Error(`logged in to tenant ${user.tenantId}, expected ${TENANT_ID} (set HOPE_TENANT_ID)`);
      if ((await ensureFinalizer(step, api, TENANT_ID, undefined, seed)) === 'published') published += 1;
    } catch (e) {
      fail(step, e.message);
    }
  }

  if (!SKIP_PLATFORM) {
    const globalStep = `global ${SLUG}`;
    const systemStep = `system ${SLUG} (promote from Global)`;
    let api = null;
    let globalOutcome = 'failed';
    try {
      api = session({ username: SUPER_USERNAME, passwordEnv: 'HOPE_SUPER_ADMIN_PASSWORD' });
      const user = await api.login();
      // A super admin authenticates tenant-less (its row lives in SYSTEM); anything else cannot promote.
      if (user.tenantId && user.tenantId !== SYSTEM_TENANT_ID) {
        throw new Error(`${SUPER_USERNAME} logged in bound to tenant ${user.tenantId}; promotion needs a tenant-less super admin`);
      }
      globalOutcome = await ensureFinalizer(globalStep, api, GLOBAL_TENANT_ID, GLOBAL_TENANT_ID, seed);
      if (globalOutcome === 'published') published += 1;
    } catch (e) {
      fail(globalStep, e.message);
    }
    if (api) {
      try {
        if (await ensureSystem(systemStep, api, seed, globalOutcome)) published += 1;
      } catch (e) {
        fail(systemStep, e.message);
      }
    } else {
      fail(systemStep, 'skipped: no super-admin session');
    }
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
