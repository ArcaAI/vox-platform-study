#!/usr/bin/env node
/**
 * TASK-1054 defect B content rollout — idempotent, through the ADMIN API only (no SQL, no seed run).
 *
 *   DRY_RUN=1 node docs/implementation/TASK-1054-E2E-Live-Sections-And-Presummary-Allergies/rollout.mjs
 *
 * A deploy never re-seeds, so a non-reset environment still serves the old ArcaAI warm-start
 * pre-summary (five headings, no Allergies & Contraindications, no Family History). This brings the
 * ARCAAI tenant onto the committed seed body (`PRE_SUMMARY_CONTENT_V3`, evaluated with tsx so no text
 * is copied here):
 *
 *   1. the pre-summary PromptTemplate (`71000000-0000-0000-0001-000000000024`): PATCH the content
 *      (mints a new PromptVersion), then re-approve so `approvedVersionNumber` pins it. Approve is a
 *      no-op on an already-APPROVED template, so the template is first PATCHed back to DRAFT in the
 *      same write that carries the new content;
 *   2. every ACTIVE agent of the tenant whose instruction names that template (the
 *      `case-notes-pre-summary` agent): new version -> PATCH `instruction.promptVersionNumber` to the
 *      new approved version -> validate -> publish + activate -> exactly one active version. Published
 *      versions are immutable, so a new agent version is the only way to move the pin.
 *
 * 3. (lane C) the DEPARTMENT-FREE pre-summary — the body the native (ALaaS / vox-node) path actually
 *    reads (`preSummaryVariant: 'dept-free'`). Seed `SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT`
 *    (`07d-dept-free-pre-summary-default.ts`) is converged, by the same PATCH-to-DRAFT + approve recipe,
 *    on THREE rows:
 *      - ArcaAI (tenant admin): the tenant clone, found by `sourceTemplateId = 71000000-…0004-…0002`
 *        (the SYSTEM pointer), else by tags `pre-summary` + `dept-free` when exactly one row matches;
 *      - Global `50000000-…0000` (super admin acting via X-Tenant-Id): found the same way;
 *      - SYSTEM `71000000-0000-0000-0004-000000000002` (tenant-less super admin): fetched by id.
 *    A refused write (e.g. SYSTEM rows are platform-admin-only) is reported as FAIL with the server
 *    message, never worked around. No agent pins these templates, so no agent republish follows.
 *
 * The generic SYSTEM pre-summary body (TASK-1054 does not change it) is NOT touched.
 *
 * Idempotent: a template whose content equals the seed AND is APPROVED at its latest version is `skip`;
 * an agent already pinned to the approved version is `skip`.
 *
 * Env:
 *   HOPE_BASE_URL          default http://localhost:8868
 *   HOPE_ADMIN_USERNAME    default arcaai_admin
 *   HOPE_ADMIN_PASSWORD    required unless the base URL is local (then the seeded dev password)
 *   HOPE_SUPER_ADMIN_USERNAME / HOPE_SUPER_ADMIN_PASSWORD  default super_admin / (local dev password);
 *                          used for the Global + SYSTEM dept-free rows. SKIP_PLATFORM=1 skips them.
 *   HOPE_TENANT_KEY        default ARCAAI
 *   HOPE_TENANT_ID         default 50000000-0000-0000-0000-000000000001 (checked against the login)
 *   DRY_RUN=1              read-only: prints `plan` for every step that would write
 *   PUBLISH_SETTLE_MS      wait after the last publish (default 15000; the per-process agent cache)
 *
 * Output: one line per step — `ok` / `skip` / `plan` / `warn` / `FAIL`. Exit code 1 on any FAIL.
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
const USERNAME = process.env.HOPE_ADMIN_USERNAME ?? 'arcaai_admin';
const TENANT_KEY = process.env.HOPE_TENANT_KEY ?? 'ARCAAI';
const TENANT_ID = process.env.HOPE_TENANT_ID ?? '50000000-0000-0000-0000-000000000001';
const SUPER_USERNAME = process.env.HOPE_SUPER_ADMIN_USERNAME ?? 'super_admin';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const SKIP_PLATFORM = process.env.SKIP_PLATFORM === '1';
const DRY = process.env.DRY_RUN === '1';
const SETTLE_MS = Number(process.env.PUBLISH_SETTLE_MS ?? 15000);
const CHANGE_REASON = 'TASK-1054 — pre-summary carries Allergies & Contraindications and Family History';
const MARKER = 'Allergies & Contraindications:';

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
    Promise.all([
      import(${JSON.stringify(`${seedDir}/07b-arcaai-clinical-content-v3.ts`)}),
      import(${JSON.stringify(`${seedDir}/07b-arcaai-clinical-templates.ts`)}),
      import(${JSON.stringify(`${seedDir}/25-agents.ts`)}),
      import(${JSON.stringify(`${seedDir}/07d-dept-free-pre-summary-default.ts`)}),
    ]).then(([c, t, a, d]) => {
      process.stdout.write('@@SEED@@' + JSON.stringify({
        body: c.PRE_SUMMARY_CONTENT_V3,
        templateId: t.ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
        agentSlug: a.PRE_SUMMARY_AGENT_SLUG,
        deptFreeBody: d.SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT,
        deptFreeSystemId: d.SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
      }));
    }).catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(tsx, ['-e', code], { cwd: resolve(REPO, 'packages/database'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const at = out.lastIndexOf('@@SEED@@');
  if (at < 0) throw new Error('seed evaluation printed no payload');
  const seed = JSON.parse(out.slice(at + '@@SEED@@'.length));
  if (!seed.body?.includes(MARKER) || !seed.body.includes('Family History:')) {
    throw new Error('the seed pre-summary carries no Allergies / Family History headings — is this checkout on TASK-1054?');
  }
  if (!seed.deptFreeBody?.includes(MARKER) || !seed.deptFreeBody.includes('Family History:') || !seed.deptFreeSystemId) {
    throw new Error('the seed dept-free pre-summary carries no Allergies / Family History headings — is this checkout on TASK-1054 lane C?');
  }
  return seed;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} -> HTTP ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 1200));
    this.status = status;
    this.body = body;
  }
}

function password(envName = 'HOPE_ADMIN_PASSWORD') {
  const p = process.env[envName];
  if (p) return p;
  if (IS_LOCAL) return 'password123'; // the seeded local demo password (packages/database seed 91-user.ts)
  throw new Error(`${envName} is required for a non-local HOPE_BASE_URL`);
}

function session({ username = USERNAME, passwordEnv = 'HOPE_ADMIN_PASSWORD', tenantKey = TENANT_KEY } = {}) {
  let token = '';
  const login = async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: password(passwordEnv), ...(tenantKey ? { tenantKey } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(`login ${username} failed: HTTP ${res.status}`);
    token = body.token;
    return body.user;
  };
  /** `ifMatch` is the row `version` (sent as the strong validator `"<version>"`). */
  const call = async (method, path, { body, ifMatch, tenant, retried = false } = {}) => {
    const headers = { authorization: `Bearer ${token}` };
    if (tenant) headers['x-tenant-id'] = tenant;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
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

/** Depth-first: does any string inside `node` contain `needle`? */
function hasText(node, needle) {
  if (typeof node === 'string') return node.includes(needle);
  if (Array.isArray(node)) return node.some((n) => hasText(n, needle));
  if (node && typeof node === 'object') return Object.values(node).some((v) => hasText(v, needle));
  return false;
}

// ---------------------------------------------------------------------------------------------
// 1. the template: new PromptVersion + re-approval
// ---------------------------------------------------------------------------------------------
/** Returns the approved version number the agents must pin, or null when nothing can proceed. */
async function convergeTemplate(step, api, seed, { templateId = seed.templateId, body = seed.body, tenant } = {}) {
  const tpl = await api.call('GET', `admin/prompt-templates/${templateId}`, { tenant });
  const contentCurrent = tpl.content === body;
  const approvedAtLatest = tpl.status === 'APPROVED' && tpl.approvedVersionNumber === tpl.currentVersionNumber;
  if (contentCurrent && approvedAtLatest) {
    skip(step, `v${tpl.approvedVersionNumber} already carries the seed body and is approved`);
    return tpl.approvedVersionNumber;
  }
  if (DRY) {
    plan(step, `${contentCurrent ? 'no content change' : `PATCH content -> v${tpl.currentVersionNumber + 1}`}, status DRAFT, then approve`);
    return contentCurrent ? tpl.currentVersionNumber : tpl.currentVersionNumber + 1;
  }
  // Content (when it differs) and the DRAFT flip go in ONE write: approve is a no-op on an APPROVED row.
  let current = tpl;
  const patch = { status: 'DRAFT', changeReason: CHANGE_REASON, ...(contentCurrent ? {} : { content: body }) };
  current = await api.call('PATCH', `admin/prompt-templates/${templateId}`, { ifMatch: current.version, body: patch, tenant });
  const approved = await api.call('POST', `admin/prompt-templates/${templateId}/approve`, { ifMatch: current.version, body: {}, tenant });
  if (approved.status !== 'APPROVED' || approved.content !== body) {
    fail(step, `after approve: status=${approved.status} contentMatchesSeed=${approved.content === body}`);
    return null;
  }
  ok(step, `approved v${approved.approvedVersionNumber} (current v${approved.currentVersionNumber})`);
  return approved.approvedVersionNumber;
}

// ---------------------------------------------------------------------------------------------
// 2. the agents that pin the template
// ---------------------------------------------------------------------------------------------
async function republish(step, api, active, instruction, approvedVersion) {
  let draft = await api.call('POST', `admin/agents/${active.id}/versions`, { body: {} });
  draft = await api.call('PATCH', `admin/agents/${draft.id}`, { ifMatch: draft.version, body: { instruction } });
  const validated = await api.call('POST', `admin/agents/${draft.id}/validate`, { body: {} });
  if (validated.validationReport?.blocking) {
    fail(step, `validate blocked: ${JSON.stringify(validated.validationReport.findings).slice(0, 500)} (draft ${draft.id} left unpublished)`);
    return false;
  }
  const pub = await api.call('POST', `admin/agents/${draft.id}/publish`, { body: { activate: true } });
  const versions = await api.call('GET', `admin/agents/${pub.id}/versions`);
  const activeCount = versions.filter((v) => v.isActive).length;
  if (activeCount !== 1) {
    fail(step, `${activeCount} active versions after publish`);
    return false;
  }
  if (pub.instruction?.promptVersionNumber !== approvedVersion) {
    fail(step, `published v${pub.versionNumber} pins prompt v${pub.instruction?.promptVersionNumber}, expected v${approvedVersion}`);
    return false;
  }
  if (pub.compiledConfig && !hasText(pub.compiledConfig, MARKER)) {
    warn(step, 'compiledConfig does not embed the template text (it may be resolved by reference at run time) — verify with a live pre-summary');
  }
  ok(step, `v${active.versionNumber} -> v${pub.versionNumber} id=${pub.id} active=1 (promptVersionNumber ${approvedVersion})`);
  return true;
}

async function convergeAgents(api, seed, approvedVersion) {
  const list = rows((await api.call('GET', 'admin/agents?task=TEXT_GENERATION')) ?? []).filter(
    (a) => a.tenantId === TENANT_ID && a.isActive && a.status === 'PUBLISHED',
  );
  let touched = 0;
  let found = 0;
  for (const row of list) {
    const agent = await api.call('GET', `admin/agents/${row.id}`);
    if (agent.instruction?.promptTemplateId !== seed.templateId) continue;
    found += 1;
    const step = `agent ${agent.slug}`;
    try {
      if (agent.instruction.promptVersionNumber === approvedVersion) {
        skip(step, `v${agent.versionNumber} already pins prompt v${approvedVersion}`);
        continue;
      }
      if (DRY) {
        plan(
          step,
          `v${agent.versionNumber} -> v${agent.versionNumber + 1}: promptVersionNumber ${agent.instruction.promptVersionNumber} -> ${approvedVersion}`,
        );
        continue;
      }
      if (await republish(step, api, agent, { ...agent.instruction, promptVersionNumber: approvedVersion }, approvedVersion)) touched += 1;
    } catch (e) {
      fail(step, e.message);
    }
  }
  if (found === 0)
    fail('agents', `no active published agent in tenant ${TENANT_ID} names template ${seed.templateId} (expected '${seed.agentSlug}')`);
  return touched;
}

// ---------------------------------------------------------------------------------------------
// 3. the department-free pre-summary (native path)
// ---------------------------------------------------------------------------------------------
/** The tenant's own dept-free template id: the clone of the SYSTEM pointer, else the single tag match. */
async function findDeptFreeId(api, seed, tenant) {
  const q = 'admin/prompt-templates?tags=pre-summary,dept-free&includeDisabled=false&limit=100';
  const listed = rows(await api.call('GET', q, { tenant }));
  const own = tenant ? listed.filter((r) => !r.tenantId || r.tenantId === tenant) : listed;
  const clones = own.filter((r) => r.sourceTemplateId === seed.deptFreeSystemId);
  if (clones.length === 1) return clones[0].id;
  if (clones.length > 1) throw new Error(`${clones.length} clones of ${seed.deptFreeSystemId} in the tenant: ${clones.map((r) => r.id).join(', ')}`);
  const tagged = own.filter((r) => Array.isArray(r.tags) && r.tags.includes('pre-summary') && r.tags.includes('dept-free'));
  if (tagged.length === 1) return tagged[0].id;
  throw new Error(`${tagged.length} dept-free pre-summary templates found by tags and no clone of ${seed.deptFreeSystemId}`);
}

async function convergeDeptFree(step, api, seed, { tenant, systemRow = false }) {
  try {
    const templateId = systemRow ? seed.deptFreeSystemId : await findDeptFreeId(api, seed, tenant);
    await convergeTemplate(`${step} (${templateId})`, api, seed, { templateId, body: seed.deptFreeBody, tenant });
  } catch (e) {
    fail(step, e.message);
  }
}

// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`TASK-1054 rollout -> ${BASE}${DRY ? ' [DRY RUN]' : ''}`);
  const seed = loadSeed();
  ok('seed', `pre-summary body ${seed.body.length} chars, template ${seed.templateId}, agent '${seed.agentSlug}'`);

  const api = session();
  const user = await api.login();
  if (user.tenantId !== TENANT_ID) throw new Error(`logged in to tenant ${user.tenantId}, expected ${TENANT_ID} (set HOPE_TENANT_ID)`);

  let approvedVersion = null;
  try {
    approvedVersion = await convergeTemplate(`template ${TENANT_KEY} pre-summary`, api, seed);
  } catch (e) {
    fail(`template ${TENANT_KEY} pre-summary`, e.message);
  }
  let published = 0;
  if (approvedVersion !== null) published = await convergeAgents(api, seed, approvedVersion);

  await convergeDeptFree(`dept-free pre-summary ${TENANT_KEY}`, api, seed, { tenant: undefined });

  if (!SKIP_PLATFORM) {
    try {
      const sa = session({ username: SUPER_USERNAME, passwordEnv: 'HOPE_SUPER_ADMIN_PASSWORD', tenantKey: undefined });
      const su = await sa.login();
      if (su.tenantId && su.tenantId !== SYSTEM_TENANT_ID) {
        throw new Error(`${SUPER_USERNAME} logged in bound to tenant ${su.tenantId}; the SYSTEM row needs a tenant-less super admin`);
      }
      await convergeDeptFree('dept-free pre-summary global', sa, seed, { tenant: GLOBAL_TENANT_ID });
      await convergeDeptFree('dept-free pre-summary system', sa, seed, { systemRow: true });
    } catch (e) {
      fail('dept-free pre-summary platform', e.message);
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
