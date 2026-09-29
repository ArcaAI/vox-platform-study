#!/usr/bin/env node
/**
 * TASK-1020 content rollout — idempotent, through the ADMIN API only (no SQL, no seed run).
 *
 *   node docs/implementation/TASK-1020-Consultation-Visit-Lifecycle-Single-And-Same-Day-Return/rollout.mjs
 *
 * Applies, for one tenant (default ARCAAI):
 *   1. the `same_day_return` fragment PromptTemplate (tenant row, APPROVED)
 *   2. that fragment, conditional, on the ACTIVE version of each `arcaai-<dept>-summary-revisit` agent
 *      (order: clinical_note, same_day_return, output-language policy) — a republish per agent,
 *      because publish FREEZES fragment text into `compiledConfig`
 *   3. the `investigations` kind on the `arcaai_consultation_scribe` context schema (publish + pin)
 *   4. the tenant setting `consultation.appointmentDay.timeZone`
 *
 * The source of truth for the text, the `when`, and the schema definition is the committed seed
 * (`packages/database/src/prisma/db_main/seed/07b-*.ts`, `07g-*.ts`), evaluated with `tsx` so
 * nothing is copied. Run from a checkout of this repo (`node_modules/.bin/tsx` must exist).
 *
 * Env:
 *   HOPE_BASE_URL         default http://localhost:8868
 *   HOPE_ADMIN_USERNAME   default arcaai_admin
 *   HOPE_ADMIN_PASSWORD   required unless the base URL is localhost/127.0.0.1 (then the seeded dev
 *                         password is the fallback). Never printed.
 *   HOPE_TENANT_KEY       default ARCAAI
 *   HOPE_TENANT_ID        default 50000000-0000-0000-0000-000000000001 (checked against the login)
 *   HOPE_TIME_ZONE        default Asia/Kolkata
 *   DRY_RUN=1             read-only: prints `plan` for every step that would write
 *   ACK_IMPACT=1          pass `acknowledgeImpact: true` on the schema publish (default: refuse)
 *   PUBLISH_SETTLE_MS     wait after the last agent publish (default 15000; the agent cache)
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
const TIME_ZONE = process.env.HOPE_TIME_ZONE ?? 'Asia/Kolkata';
const DRY = process.env.DRY_RUN === '1';
const ACK_IMPACT = process.env.ACK_IMPACT === '1';
const SETTLE_MS = Number(process.env.PUBLISH_SETTLE_MS ?? 15000);
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);
const TZ_KEY = 'consultation.appointmentDay.timeZone';
const EXPECTED_REVISIT_AGENTS = 11;

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
    Promise.all([
      import(${JSON.stringify(`${seedDir}/07b-arcaai-clinical-templates.ts`)}),
      import(${JSON.stringify(`${seedDir}/07g-arcaai-two-schemas.ts`)}),
    ]).then(([t, s]) => {
      const tpl = t.ARCAAI_SAME_DAY_RETURN_TEMPLATE;
      process.stdout.write('@@SEED@@' + JSON.stringify({
        template: { name: tpl.name, description: tpl.description, content: tpl.content, category: tpl.category, tags: tpl.tags, scope: tpl.scope },
        sameDayKey: t.ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY,
        sameDayWhen: t.ARCAAI_SAME_DAY_RETURN_WHEN,
        policyKey: t.ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
        scribeSlug: s.ARCAAI_CONSULTATION_SCRIBE_SLUG,
        scribeDefinition: s.ARCAAI_CONSULTATION_SCRIBE_DEFINITION,
      }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(tsx, ['-e', code], { cwd: resolve(REPO, 'packages/database'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const at = out.lastIndexOf('@@SEED@@');
  if (at < 0) throw new Error('seed evaluation printed no payload');
  return JSON.parse(out.slice(at + '@@SEED@@'.length));
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

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
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
// 1. the fragment template
// ---------------------------------------------------------------------------------------------
async function ensureTemplate(seed) {
  const step = 'template same_day_return';
  const tag = 'arcaai-same-day-return';
  const listed = rows(await get(`admin/prompt-templates?tags=${encodeURIComponent(tag)}&includeDisabled=true&limit=100`)).filter(
    (t) => (t.tenantId ?? TENANT_ID) === TENANT_ID && (t.tags ?? []).includes(tag),
  );
  let tpl = listed[0] ? await get(`admin/prompt-templates/${listed[0].id}`) : null;

  const contentOk = tpl && tpl.content === seed.template.content;
  const approved = tpl && tpl.status === 'APPROVED';
  if (tpl && contentOk && approved) {
    skip(step, `id=${tpl.id} status=APPROVED approvedVersion=${tpl.approvedVersionNumber} rowVersion=${tpl.version}`);
    return tpl;
  }
  if (DRY) {
    plan(step, !tpl ? 'create (DRAFT) + approve' : !contentOk ? `PATCH content + status DRAFT, then approve (id=${tpl.id})` : `approve (id=${tpl.id}, status=${tpl.status})`);
    return tpl;
  }
  if (!tpl) {
    tpl = await call('POST', 'admin/prompt-templates', {
      body: {
        name: seed.template.name,
        description: seed.template.description,
        content: seed.template.content,
        category: seed.template.category,
        scope: seed.template.scope,
        tags: seed.template.tags,
      },
    });
  } else if (!contentOk) {
    // approve is a no-op on an APPROVED row — a content change must go back through DRAFT first.
    tpl = await call('PATCH', `admin/prompt-templates/${tpl.id}`, {
      ifMatch: tpl.version,
      body: { content: seed.template.content, status: 'DRAFT', changeReason: 'TASK-1020 rollout — sync same-day-return fragment body with the seed' },
    });
  }
  if (tpl.status !== 'APPROVED') {
    tpl = await call('POST', `admin/prompt-templates/${tpl.id}/approve`, { ifMatch: tpl.version, body: {} });
  }
  if (tpl.status !== 'APPROVED' || tpl.content !== seed.template.content) throw new Error(`template not APPROVED with seed content (status=${tpl.status})`);
  ok(step, `id=${tpl.id} status=${tpl.status} approvedVersion=${tpl.approvedVersionNumber} rowVersion=${tpl.version}`);
  return tpl;
}

async function findPolicyTemplateId() {
  const listed = rows(await get(`admin/prompt-templates?tags=output-language&limit=100`)).filter(
    (t) => (t.tenantId ?? TENANT_ID) === TENANT_ID && t.status === 'APPROVED',
  );
  return listed[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// 2. the revisit agents
// ---------------------------------------------------------------------------------------------
/** The instruction the revisit agent must carry, derived from what it carries now. `null` = cannot derive. */
function desiredInstruction(current, tpl, seed, policyTemplateId) {
  const sameDay = { key: seed.sameDayKey, promptTemplateId: tpl.id, when: seed.sameDayWhen };
  let fragments;
  let carried = {};
  if (Array.isArray(current?.fragments)) {
    fragments = current.fragments.filter((f) => f.key !== seed.sameDayKey);
    const { fragments: _f, ...rest } = current;
    carried = rest;
  } else if (current?.promptTemplateId) {
    // pre-TASK-1001 single-template form: lift it into the composite shape the seed now uses.
    const { promptTemplateId, promptVersionNumber, variables, evalGate, ...rest } = current;
    carried = { ...rest, ...(variables ? { variables } : {}), ...(evalGate ? { evalGate } : {}) };
    fragments = [{ key: 'clinical_note', promptTemplateId, ...(promptVersionNumber ? { promptVersionNumber } : {}) }];
    if (!policyTemplateId) return null;
    fragments.push({ key: seed.policyKey, promptTemplateId: policyTemplateId });
  } else {
    return null;
  }
  const noteIdx = fragments.findIndex((f) => f.key === 'clinical_note');
  if (noteIdx < 0) return null;
  fragments.splice(noteIdx + 1, 0, sameDay);
  return { ...carried, fragments };
}

const fragmentBound = (instr, tpl, seed) =>
  Array.isArray(instr?.fragments) &&
  (() => {
    const i = instr.fragments.findIndex((f) => f.key === seed.sameDayKey);
    return (
      i > 0 &&
      instr.fragments[i - 1].key === 'clinical_note' &&
      instr.fragments[i].promptTemplateId === tpl.id &&
      instr.fragments[i].when === seed.sameDayWhen &&
      instr.fragments[i + 1]?.key === seed.policyKey
    );
  })();

async function ensureAgents(seed, tplIn) {
  // In a dry run before the template exists, plan against a placeholder id.
  const tpl = tplIn ?? { id: '<new-template-id>' };
  const list = (await get('admin/agents?task=TEXT_GENERATION')) ?? [];
  const revisit = rows(list).filter((a) => /^arcaai-.+-summary-revisit$/.test(a.slug) && a.tenantId === TENANT_ID);
  const actives = revisit.filter((a) => a.isActive && a.status === 'PUBLISHED');
  if (actives.length !== EXPECTED_REVISIT_AGENTS) {
    fail('agents', `expected ${EXPECTED_REVISIT_AGENTS} active published revisit agents, found ${actives.length}`);
  }
  const policyTemplateId = await findPolicyTemplateId();
  const marker = seed.template.content;
  let published = 0;

  for (const listedAgent of actives.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const step = `agent ${listedAgent.slug}`;
    try {
      const active = await get(`admin/agents/${listedAgent.id}`);
      const bound = tpl.id !== '<new-template-id>' && fragmentBound(active.instruction, tpl, seed);
      const frozenAt = tplIn ? findText(active.compiledConfig, marker) : null;
      if (bound && frozenAt) {
        skip(step, `v${active.versionNumber} active, fragment bound and frozen at ${frozenAt}`);
        continue;
      }
      const instruction = desiredInstruction(active.instruction, tpl, seed, policyTemplateId);
      if (!instruction) {
        fail(step, `cannot derive fragments (no clinical_note/promptTemplateId or no output-language policy template); instruction keys=${Object.keys(active.instruction ?? {})}`);
        continue;
      }
      if (DRY) {
        plan(step, `v${active.versionNumber} -> v${active.versionNumber + 1}: bound=${bound} frozen=${Boolean(frozenAt)}; fragments=[${instruction.fragments.map((f) => f.key).join(', ')}]`);
        continue;
      }
      let draft = await call('POST', `admin/agents/${active.id}/versions`, { body: {} });
      draft = await call('PATCH', `admin/agents/${draft.id}`, { ifMatch: draft.version, body: { instruction } });
      const validated = await call('POST', `admin/agents/${draft.id}/validate`, { body: {} });
      if (validated.validationReport?.blocking) {
        fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
        continue;
      }
      const pub = await call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true } });
      published += 1;
      const versions = await get(`admin/agents/${pub.id}/versions`);
      const activeCount = versions.filter((v) => v.isActive).length;
      const frozen = findText(pub.compiledConfig, marker);
      if (activeCount !== 1) fail(step, `${activeCount} active versions after publish`);
      else if (!frozen) fail(step, `published v${pub.versionNumber} but the fragment text is not frozen into compiledConfig`);
      else ok(step, `v${active.versionNumber} -> v${pub.versionNumber} id=${pub.id} active=1 frozen at ${frozen}`);
    } catch (e) {
      fail(step, e.message);
    }
  }
  if (published > 0 && SETTLE_MS > 0) {
    line('ok', 'agents settle', `waiting ${SETTLE_MS} ms for the per-process agent cache`);
    await sleep(SETTLE_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. the context schema
// ---------------------------------------------------------------------------------------------
async function ensureSchema(seed) {
  const step = `context schema ${seed.scribeSlug}`;
  const schema = rows(await get('admin/consultation-context-schemas')).find((s) => s.slug === seed.scribeSlug && s.tenantId === TENANT_ID);
  if (!schema) return fail(step, 'schema not found for the tenant');
  const versions = await get(`admin/consultation-context-schemas/${schema.id}/versions`);
  const pinned = versions.find((v) => v.versionNumber === schema.pinnedVersionNumber);
  const kindsOf = (d) => new Set((d?.kinds ?? []).map((k) => k.key));
  const seedInv = seed.scribeDefinition.kinds.find((k) => k.key === 'investigations');
  const pinnedInv = pinned?.definition?.kinds?.find((k) => k.key === 'investigations');
  if (pinned && stable(pinnedInv) === stable(seedInv) && stable(pinned.definition) === stable(seed.scribeDefinition)) {
    return skip(step, `pinned v${pinned.versionNumber} already equals the seed definition (investigations present)`);
  }
  if (DRY) {
    return plan(step, `publish seed definition over pinned v${pinned?.versionNumber} (kinds now: ${[...kindsOf(pinned?.definition)].join(', ')})`);
  }
  try {
    const res = await call('POST', `admin/consultation-context-schemas/${schema.id}/publish`, {
      body: {
        definition: seed.scribeDefinition,
        changeReason: 'TASK-1020 OD-6 — add the investigations kind (lab results at the encounter)',
        ...(ACK_IMPACT ? { acknowledgeImpact: true } : {}),
      },
    });
    const after = await get(`admin/consultation-context-schemas/${schema.id}/versions`);
    const now = after.find((v) => v.versionNumber === res.pinnedVersionNumber);
    const has = now?.definition?.kinds?.some((k) => k.key === 'investigations');
    const impact = res.impact
      ? ` impact: workflows ${JSON.stringify(countBy(res.impact.workflows))} agents ${JSON.stringify(countBy(res.impact.agents))}`
      : '';
    if (!has) return fail(step, `published but pinned v${res.pinnedVersionNumber} has no investigations kind`);
    ok(step, `pinned v${res.pinnedVersionNumber} includes investigations;${impact}`);
  } catch (e) {
    fail(step, e.body?.code === 'SCHEMA_IMPACT_UNACKNOWLEDGED' ? `${e.message.slice(0, 300)} — review impact, re-run with ACK_IMPACT=1` : e.message);
  }
}
const countBy = (list) =>
  (list ?? []).reduce((m, u) => {
    const k = `${u.binding}/${u.verdict}`;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

// ---------------------------------------------------------------------------------------------
// 4. the setting
// ---------------------------------------------------------------------------------------------
async function ensureSetting() {
  const step = `setting ${TZ_KEY}`;
  const cur = await get(`admin/settings/registry/${TZ_KEY}?scope=tenant`);
  if (cur.sourceScope === 'tenant' && cur.value === TIME_ZONE) {
    return skip(step, `tenant value already ${JSON.stringify(cur.value)} (row version ${cur.version})`);
  }
  if (DRY) return plan(step, `PUT ${JSON.stringify(TIME_ZONE)} at scope=tenant (effective now ${JSON.stringify(cur.value)} from ${cur.sourceScope})`);
  // `version` > 0 with sourceScope tenant = a tenant row exists, so a precondition is required.
  const hasTenantRow = cur.sourceScope === 'tenant' && cur.version > 0;
  await call('PUT', `admin/settings/registry/${TZ_KEY}`, {
    body: { value: TIME_ZONE, scope: 'tenant' },
    ...(hasTenantRow ? { ifMatch: cur.version } : {}),
  });
  const back = await get(`admin/settings/registry/${TZ_KEY}?scope=tenant`);
  if (back.value !== TIME_ZONE || back.sourceScope !== 'tenant') return fail(step, `read-back mismatch: value=${JSON.stringify(back.value)} source=${back.sourceScope}`);
  ok(step, `read back ${JSON.stringify(back.value)} from scope=${back.sourceScope} (row version ${back.version})`);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`TASK-1020 rollout -> ${BASE} tenant=${TENANT_KEY}${DRY ? ' [DRY RUN]' : ''}`);
  const seed = loadSeed();
  const user = await login();
  if (user.tenantId !== TENANT_ID) throw new Error(`logged in to tenant ${user.tenantId}, expected ${TENANT_ID} (set HOPE_TENANT_ID)`);
  ok('login', `${USERNAME} tenant=${user.tenantId} roles=${(user.roles ?? []).join(',')}`);

  let tpl = null;
  try {
    tpl = await ensureTemplate(seed);
  } catch (e) {
    fail('template same_day_return', e.message);
  }
  if (tpl || DRY) {
    try {
      await ensureAgents(seed, tpl);
    } catch (e) {
      fail('agents', e.message);
    }
  } else {
    fail('agents', 'skipped: template step failed');
  }
  try {
    await ensureSchema(seed);
  } catch (e) {
    fail('context schema', e.message);
  }
  try {
    await ensureSetting();
  } catch (e) {
    fail(`setting ${TZ_KEY}`, e.message);
  }
  console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps ok');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL fatal — ${e.message}`);
  process.exit(1);
});
