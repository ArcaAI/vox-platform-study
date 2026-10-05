#!/usr/bin/env node
/**
 * TASK-1045 content rollout — idempotent, through the ADMIN API only (no SQL, no seed run).
 *
 *   DRY_RUN=1 node docs/implementation/TASK-1045-Consultation-Lifecycle-Simplification/rollout.mjs
 *
 * A fresh database needs none of this: the seeds ARE the source of truth for a new environment
 * (README D-10 / D-20). This script converts an environment that was NOT reset:
 *
 *   1. `casenote-finalization` — the transcript-based body AND the output schema with the optional
 *      `sources` array — republished for ArcaAI (tenant admin), Global (super admin elevated into
 *      Global) and SYSTEM (PROMOTED from Global, rule 00 D-8);
 *   2. `fact-ledger-extraction` — created (published + activated) in ArcaAI and Global when absent,
 *      then promoted into SYSTEM;
 *   3. every LLM (TEXT_GENERATION) agent of ArcaAI and Global whose `parameters.generation.temperature`
 *      is not 0 — republished with temperature 0 (SYSTEM copies are re-promoted from Global);
 *   4. the gemma serving profile (32768, q4_0/q4_0 KV cache, flash attention) — REPORTED only: no
 *      admin route writes an LM Studio row's `_metadata.serving` / `_metadata.contextLength`
 *      (`PATCH admin/ai-models/:id` carries only the vLLM sizing facts), so the line says what to
 *      change and where. A reset environment gets it from `seed/ai-models/llm.ts`.
 *
 * The republish recipe is TASK-1020/1022's (publish FREEZES text into `compiledConfig`): new version
 * -> PATCH under If-Match -> validate -> publish + activate -> exactly one active version. A published
 * version is immutable (DB trigger), so there is no in-place edit. Idempotent: a step whose active
 * version already matches the seed is `skip`. The seed (`packages/database/.../seed/25-agents.ts`) is
 * evaluated with `tsx`, so no text is copied. Run from a checkout with `node_modules/.bin/tsx`.
 *
 * Env: as TASK-1022 — HOPE_BASE_URL, HOPE_ADMIN_USERNAME / HOPE_ADMIN_PASSWORD, HOPE_TENANT_KEY,
 * HOPE_TENANT_ID, HOPE_SUPER_ADMIN_USERNAME / HOPE_SUPER_ADMIN_PASSWORD, SKIP_TENANT=1, SKIP_PLATFORM=1,
 * PUBLISH_SETTLE_MS, and `DRY_RUN=1` (read-only: prints `plan` for every step that would write).
 *
 * Output: one line per step — `ok` / `skip` / `plan` / `warn` / `FAIL`. Exit code 1 on any FAIL.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

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
const FINALIZER = 'casenote-finalization';
const LEDGER = 'fact-ledger-extraction';
const CHANGE_REASON = 'TASK-1045 — transcript-based finalizer, fact-ledger extractor, temperature 0';

let failures = 0;
const line = (status, step, detail = '') => console.log(`${status.padEnd(4)} ${step}${detail ? ` — ${detail}` : ''}`);
const ok = (s, d) => line('ok', s, d);
const skip = (s, d) => line('skip', s, d);
const plan = (s, d) => line('plan', s, d);
const warn = (s, d) => line('warn', s, d);
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
    Promise.all([import(${JSON.stringify(`${seedDir}/25-agents.ts`)}), import(${JSON.stringify(`${seedDir}/ai-models/llm.ts`)})]).then(([a, m]) => {
      const gemma = m.LLM_AI_MODELS.find((x) => x.slug === 'lms-gemma-4-e2b-it-qat');
      const spec = (slug) => a.PLATFORM_AGENT_SPECS.find((s) => s.slug === slug);
      process.stdout.write('@@SEED@@' + JSON.stringify({
        baseKey: a.CLINICAL_NOTE_FRAGMENT_KEY,
        finalizer: { body: a.CASENOTE_FINALIZATION_SYSTEM_PROMPT, outputSchema: a.CASENOTE_OUTPUT_SCHEMA, parameters: a.CASENOTE_FINALIZATION_PARAMETERS },
        ledger: { name: spec(a.FACT_LEDGER_AGENT_SLUG).name, description: spec(a.FACT_LEDGER_AGENT_SLUG).description, instruction: spec(a.FACT_LEDGER_AGENT_SLUG).instruction, parameters: a.FACT_LEDGER_PARAMETERS, outputSchema: a.FACT_LEDGER_OUTPUT_SCHEMA, tags: spec(a.FACT_LEDGER_AGENT_SLUG).tags.filter((t) => !t.startsWith('tier:')) },
        gemma: { slug: gemma.slug, contextLength: gemma.metaData.contextLength, serving: gemma.metaData.serving },
      }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(tsx, ['-e', code], { cwd: resolve(REPO, 'packages/database'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const at = out.lastIndexOf('@@SEED@@');
  if (at < 0) throw new Error('seed evaluation printed no payload');
  const seed = JSON.parse(out.slice(at + '@@SEED@@'.length));
  if (!seed.finalizer.outputSchema?.properties?.sources || !seed.ledger?.outputSchema) {
    throw new Error('the seed carries no finalizer `sources` schema / ledger agent — is this checkout on TASK-1045?');
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
// desired state
// ---------------------------------------------------------------------------------------------
const temperatureOf = (agent) => agent.parameters?.generation?.temperature;

/** The instruction with the BASE fragment's inline body replaced, everything else carried. */
function withBody(current, body, baseKey) {
  if (Array.isArray(current?.fragments)) {
    const fragments = current.fragments.map((f) => ({ ...f }));
    const at = Math.max(0, fragments.findIndex((f) => f.key === baseKey));
    if (typeof fragments[at]?.systemPrompt !== 'string') return { error: `base fragment '${fragments[at]?.key}' is not an inline systemPrompt; rewrite it by hand` };
    fragments[at] = { ...fragments[at], systemPrompt: body };
    return { instruction: { ...current, fragments } };
  }
  if (typeof current?.systemPrompt === 'string') return { instruction: { ...current, systemPrompt: body } };
  return { error: `cannot find an inline base body; instruction keys=${Object.keys(current ?? {})}` };
}

/** What an agent must change to match `want` ({ body?, outputSchema?, parameters?, temperatureZero? }); `{}` = nothing. */
function diffAgent(agent, want, baseKey) {
  const patch = {};
  if (want.body !== undefined) {
    const derived = withBody(agent.instruction, want.body, baseKey);
    if (derived.error) return { error: derived.error };
    if (!isDeepStrictEqual(derived.instruction, agent.instruction) || !findText(agent.compiledConfig, want.body)) patch.instruction = derived.instruction;
  }
  if (want.outputSchema !== undefined && !isDeepStrictEqual(agent.outputSchema, want.outputSchema)) patch.outputSchema = want.outputSchema;
  if (want.parameters !== undefined && !isDeepStrictEqual(agent.parameters, want.parameters)) patch.parameters = want.parameters;
  if (want.temperatureZero && temperatureOf(agent) !== 0 && patch.parameters === undefined) {
    patch.parameters = { ...agent.parameters, generation: { ...(agent.parameters?.generation ?? {}), temperature: 0 } };
  }
  return { patch };
}

async function listActive(api, tenantId, tenant) {
  const list = rows((await api.call('GET', 'admin/agents?task=TEXT_GENERATION', { tenant })) ?? []);
  return list.filter((a) => a.tenantId === tenantId && a.isActive && a.status === 'PUBLISHED');
}

/** New version -> PATCH -> validate -> publish + activate -> exactly one active version. */
async function republish(step, api, tenant, active, patch, marker) {
  let draft = await api.call('POST', `admin/agents/${active.id}/versions`, { body: {}, tenant });
  draft = await api.call('PATCH', `admin/agents/${draft.id}`, { ifMatch: draft.version, body: patch, tenant });
  const validated = await api.call('POST', `admin/agents/${draft.id}/validate`, { body: {}, tenant });
  if (validated.validationReport?.blocking) {
    fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
    return false;
  }
  const pub = await api.call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true }, tenant });
  const versions = await api.call('GET', `admin/agents/${pub.id}/versions`, { tenant });
  const activeCount = versions.filter((v) => v.isActive).length;
  if (activeCount !== 1) fail(step, `${activeCount} active versions after publish`);
  else if (marker && !findText(pub.compiledConfig, marker)) fail(step, `published v${pub.versionNumber} but the new body is not frozen into compiledConfig`);
  else ok(step, `v${active.versionNumber} -> v${pub.versionNumber} id=${pub.id} active=1 (${Object.keys(patch).join(', ')})`);
  return true;
}

/** Converge one active agent onto `want`. Returns 'published' | 'current' | 'planned' | 'failed'. */
async function converge(step, api, tenant, active, want, seed) {
  const { patch, error } = diffAgent(active, want, seed.baseKey);
  if (error) {
    fail(step, error);
    return 'failed';
  }
  if (Object.keys(patch).length === 0) {
    skip(step, `v${active.versionNumber} already matches`);
    return 'current';
  }
  if (DRY) {
    plan(step, `v${active.versionNumber} -> v${active.versionNumber + 1}: ${Object.keys(patch).join(', ')}`);
    return 'planned';
  }
  const full = await api.call('GET', `admin/agents/${active.id}`, { tenant });
  return (await republish(step, api, tenant, full, patch, want.body)) ? 'published' : 'failed';
}

/** Create `LEDGER` in a tenant when absent (published + activated). */
async function ensureLedger(step, api, tenant, finalizer, seed) {
  const existing = (await listActive(api, finalizer.tenantId, tenant)).find((a) => a.slug === LEDGER);
  if (existing) return converge(step, api, tenant, existing, { body: undefined, outputSchema: seed.ledger.outputSchema, parameters: seed.ledger.parameters }, seed);
  if (DRY) {
    plan(step, 'create + publish + activate v1 on the finalizer`s model');
    return 'planned';
  }
  const modelId = finalizer.modelId ?? finalizer.model?.id;
  if (!modelId) {
    fail(step, 'the finalizer carries no modelId to reuse');
    return 'failed';
  }
  const draft = await api.call('POST', 'admin/agents', {
    tenant,
    body: {
      slug: LEDGER,
      name: seed.ledger.name,
      description: seed.ledger.description,
      task: 'TEXT_GENERATION',
      modelId,
      instruction: seed.ledger.instruction,
      parameters: seed.ledger.parameters,
      outputSchema: seed.ledger.outputSchema,
      tags: seed.ledger.tags,
    },
  });
  const validated = await api.call('POST', `admin/agents/${draft.id}/validate`, { body: {}, tenant });
  if (validated.validationReport?.blocking) {
    fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
    return 'failed';
  }
  const pub = await api.call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true }, tenant });
  ok(step, `created v${pub.versionNumber} id=${pub.id}`);
  return 'published';
}

/** Promote one slug from Global into SYSTEM (tenant-less super admin). */
async function promote(step, api, slug) {
  if (DRY) {
    plan(step, `promote Global's active ${slug} into SYSTEM`);
    return false;
  }
  const res = await api.call('POST', 'admin/agents/promote-to-system', { body: { sourceSlug: slug, changeReason: CHANGE_REASON } });
  ok(step, `SYSTEM v${res.versionNumber} id=${res.agentId} promotion=${res.promotionId}`);
  return true;
}

/** One source tenant: finalizer, ledger, then every LLM agent with temperature != 0. Returns the slugs it republished. */
async function convergeTenant(label, api, tenantId, tenant, seed) {
  const touched = new Set();
  const actives = await listActive(api, tenantId, tenant);
  const finalizerRow = actives.find((a) => a.slug === FINALIZER);
  if (!finalizerRow) {
    fail(`${label} ${FINALIZER}`, `expected 1 active published ${FINALIZER} in tenant ${tenantId}, found 0`);
    return { touched, failed: true };
  }
  const finalizer = await api.call('GET', `admin/agents/${finalizerRow.id}`, { tenant });
  let failed = false;
  const run = async (step, fn, slug) => {
    try {
      const outcome = await fn();
      if (outcome === 'published') touched.add(slug);
      if (outcome === 'failed') failed = true;
    } catch (e) {
      fail(step, e.message);
      failed = true;
    }
  };
  await run(`${label} ${FINALIZER}`, () => converge(`${label} ${FINALIZER}`, api, tenant, finalizer, { body: seed.finalizer.body, outputSchema: seed.finalizer.outputSchema, parameters: seed.finalizer.parameters }, seed), FINALIZER);
  await run(`${label} ${LEDGER}`, () => ensureLedger(`${label} ${LEDGER}`, api, tenant, finalizer, seed), LEDGER);
  for (const row of actives.filter((a) => a.slug !== FINALIZER && a.slug !== LEDGER)) {
    const full = await api.call('GET', `admin/agents/${row.id}`, { tenant });
    if (temperatureOf(full) === 0) continue;
    const step = `${label} ${row.slug} (temperature ${temperatureOf(full) ?? 'unset'})`;
    await run(step, () => converge(step, api, tenant, full, { temperatureZero: true }, seed), row.slug);
  }
  return { touched, failed };
}

/** The gemma serving profile: reported, not written — no admin route owns it. */
function reportGemma(seed) {
  const g = seed.gemma;
  warn(
    `gemma serving profile (${g.slug})`,
    `target contextLength=${g.contextLength} serving=${JSON.stringify(g.serving)}; no admin route writes an LM Studio row's _metadata.serving/contextLength ` +
      '(PATCH admin/ai-models/:id takes only vLLM sizing facts) — change the stored row out of band, or reset (seed/ai-models/llm.ts carries it). ' +
      'Deployment: base/lmstudio.yaml LMS_CONTEXT + LMS_PRELOAD_PLAN must say the same (declared must not exceed served).',
  );
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`TASK-1045 rollout -> ${BASE}${DRY ? ' [DRY RUN]' : ''}`);
  const seed = loadSeed();
  ok('seed', `finalizer body ${seed.finalizer.body.length} chars, output schema carries 'sources', ledger agent '${LEDGER}'`);
  let published = 0;

  if (!SKIP_TENANT) {
    try {
      const api = session({ username: TENANT_USERNAME, passwordEnv: 'HOPE_ADMIN_PASSWORD', tenantKey: TENANT_KEY });
      const user = await api.login();
      if (user.tenantId !== TENANT_ID) throw new Error(`logged in to tenant ${user.tenantId}, expected ${TENANT_ID} (set HOPE_TENANT_ID)`);
      published += (await convergeTenant(`tenant ${TENANT_KEY}`, api, TENANT_ID, undefined, seed)).touched.size;
    } catch (e) {
      fail(`tenant ${TENANT_KEY}`, e.message);
    }
  }

  if (!SKIP_PLATFORM) {
    try {
      const api = session({ username: SUPER_USERNAME, passwordEnv: 'HOPE_SUPER_ADMIN_PASSWORD' });
      const user = await api.login();
      if (user.tenantId && user.tenantId !== SYSTEM_TENANT_ID) {
        throw new Error(`${SUPER_USERNAME} logged in bound to tenant ${user.tenantId}; promotion needs a tenant-less super admin`);
      }
      const { touched, failed } = await convergeTenant('global', api, GLOBAL_TENANT_ID, GLOBAL_TENANT_ID, seed);
      published += touched.size;
      // SYSTEM is promoted FROM Global, so a failed Global step must not promote half a change.
      const systemSlugs = new Set((await listActive(api, SYSTEM_TENANT_ID, SYSTEM_TENANT_ID)).map((a) => a.slug));
      systemSlugs.add(LEDGER);
      systemSlugs.add(FINALIZER);
      for (const slug of [...systemSlugs].filter((s) => touched.has(s) || DRY)) {
        const step = `system ${slug} (promote from Global)`;
        if (failed) {
          fail(step, 'skipped: the Global step failed, and SYSTEM is promoted FROM Global');
          continue;
        }
        try {
          if (await promote(step, api, slug)) published += 1;
        } catch (e) {
          fail(step, e.message);
        }
      }
    } catch (e) {
      fail('platform', e.message);
    }
  }

  reportGemma(seed);

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
