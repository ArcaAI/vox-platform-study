/**
 * Pure rules behind `/guardrails/control` (TASK-1050 W3c). No React here: the screen components call
 * these, and the unit tests pin them directly.
 */

import type { GuardrailJudgePromptParts } from '@arcaai/types';
import { GatewayError } from '@/shared/api';
import type {
  GuardrailAction,
  GuardrailDirection,
  GuardrailEffectivePolicy,
  GuardrailStatedCheck,
  GuardrailStoredPolicy,
  ModelNotResidentDetails,
} from '../api/types';

// ── Errors ───────────────────────────────────────────────────────────────────

/** The toast text for a failed write. 412 / 428 get the OCC wording; everything else its gateway message. */
export function writeErrorMessage(error: unknown): string {
  if (error instanceof GatewayError) {
    if (error.isVersionConflict)
      return 'This was changed by someone else since you loaded it. Reload to see the latest version, then reapply your change.';
    if (error.isMissingPrecondition) return 'The save carried no version to check against. Reload the screen and try again.';
    const problems = (error.details as { problems?: { message?: string }[] } | undefined)?.problems;
    if (Array.isArray(problems) && problems.length > 0) {
      return `${error.message} ${problems
        .map((problem) => problem.message)
        .filter(Boolean)
        .join('; ')}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The request failed.';
}

/** The 409 `MODEL_NOT_RESIDENT` body of a dry run, or `null` for any other error. */
export function modelNotResident(error: unknown): ModelNotResidentDetails | null {
  if (!(error instanceof GatewayError) || error.status !== 409) return null;
  const details = error.details as Partial<ModelNotResidentDetails> | undefined;
  return details?.code === 'MODEL_NOT_RESIDENT' ? (details as ModelNotResidentDetails) : null;
}

/**
 * Every `admin/guardrail/{policy-keys,judge-*,dry-run,metrics}` route is SUPER_ADMIN in a tenant-LESS
 * context: with a customer working tenant selected the gateway answers 403. The screen says so in words.
 */
export function isPlatformScopeForbidden(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 403;
}

// ── Judge template ───────────────────────────────────────────────────────────

const SECTION = /<section id="([^"]*)">([\s\S]*?)<\/section>/g;

/** The three editable sections of a template prompt, or `null` when the text does not follow the template. */
export function parseJudgePromptParts(text: unknown): GuardrailJudgePromptParts | null {
  if (typeof text !== 'string') return null;
  const bodies = new Map<string, string>();
  for (const match of text.matchAll(SECTION)) bodies.set(match[1] as string, (match[2] as string).trim());
  const roleAndTask = bodies.get('role_and_task');
  const unsafeDefinitions = bodies.get('unsafe_definitions');
  const safeExamples = bodies.get('safe_examples');
  if (roleAndTask === undefined || unsafeDefinitions === undefined || safeExamples === undefined) return null;
  return { roleAndTask, unsafeDefinitions, safeExamples };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff (LCS). Prompts are a few dozen lines, so the quadratic table is fine. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] as string });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] as string });
  return out;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// ── Rules: v2 policy write ───────────────────────────────────────────────────

const ACTIONS: readonly GuardrailAction[] = ['ignore', 'warn', 'block'];
const DIRECTIONS: readonly GuardrailDirection[] = ['inbound', 'outbound'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isAction = (value: unknown): value is GuardrailAction => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);

/** What a stored row STATED, v2 or the legacy flat shape. Lenient; `setBy` is dropped (server-stamped). */
export function toStoredPolicy(raw: unknown): GuardrailStoredPolicy {
  const out: GuardrailStoredPolicy = { directions: {}, checks: {} };
  if (!isPlainObject(raw)) return out;
  const v2 = 'checks' in raw || 'directions' in raw;
  if (v2 && isPlainObject(raw.directions)) {
    for (const direction of DIRECTIONS) {
      const entry = raw.directions[direction];
      if (isPlainObject(entry) && typeof entry.enabled === 'boolean') out.directions[direction] = { enabled: entry.enabled };
    }
  }
  const source = v2 ? (isPlainObject(raw.checks) ? raw.checks : {}) : raw;
  for (const [id, entry] of Object.entries(source)) {
    if (!isPlainObject(entry)) continue;
    const stated: GuardrailStatedCheck = {};
    if (typeof entry.enabled === 'boolean') stated.enabled = entry.enabled;
    if (isAction(entry.action)) stated.action = entry.action;
    if (typeof entry.locked === 'boolean') stated.locked = entry.locked;
    if (typeof entry.minScore === 'number') stated.minScore = entry.minScore;
    if (isAction(entry.dataRegionAction)) stated.dataRegionAction = entry.dataRegionAction;
    if (Object.keys(stated).length > 0) out.checks[id] = stated;
  }
  return out;
}

export interface CheckDraft {
  enabled: boolean;
  action: GuardrailAction;
  locked: boolean;
  dataRegionAction?: GuardrailAction;
}

export interface PolicyDraft {
  directions: Record<GuardrailDirection, { enabled: boolean }>;
  checks: Record<string, CheckDraft>;
}

/** The editable projection of the policy in force. `locked` is the PLATFORM lock (a catalogue lock is not editable). */
export function draftFromView(view: GuardrailEffectivePolicy): PolicyDraft {
  const checks: Record<string, CheckDraft> = {};
  for (const check of view.checks) {
    checks[check.checkId] = {
      enabled: check.enabled,
      action: check.action,
      locked: check.lockReason === 'platform',
      ...(check.dataRegionAction ? { dataRegionAction: check.dataRegionAction } : {}),
    };
  }
  return { directions: { inbound: { ...view.directions.inbound }, outbound: { ...view.directions.outbound } }, checks };
}

/**
 * The whole row to PUT: the stored row, plus every field the draft changed relative to the policy in
 * force. Unchanged fields stay unstated, so they keep following SYSTEM / the catalogue. A catalogue-locked
 * check is never written (the gateway refuses any change to it: 403 `GUARDRAIL_CHECK_LOCKED`).
 */
export function buildPolicyWrite(stored: GuardrailStoredPolicy, view: GuardrailEffectivePolicy, draft: PolicyDraft): GuardrailStoredPolicy {
  const next: GuardrailStoredPolicy = {
    directions: { ...stored.directions },
    checks: Object.fromEntries(Object.entries(stored.checks).map(([id, entry]) => [id, { ...entry }])),
  };
  for (const direction of DIRECTIONS) {
    if (draft.directions[direction].enabled !== view.directions[direction].enabled)
      next.directions[direction] = { enabled: draft.directions[direction].enabled };
  }
  const baseline = draftFromView(view);
  for (const check of view.checks) {
    if (check.lockReason === 'catalogue') continue;
    const before = baseline.checks[check.checkId]!;
    const after = draft.checks[check.checkId];
    if (!after) continue;
    const entry: GuardrailStatedCheck = { ...(next.checks[check.checkId] ?? {}) };
    if (after.enabled !== before.enabled) entry.enabled = after.enabled;
    if (after.action !== before.action) entry.action = after.action;
    if (after.locked !== before.locked) entry.locked = after.locked;
    if (after.dataRegionAction !== before.dataRegionAction && after.dataRegionAction) entry.dataRegionAction = after.dataRegionAction;
    if (Object.keys(entry).length > 0) next.checks[check.checkId] = entry;
  }
  return next;
}

/** The stored row with one check's tenant entry removed: that check follows the platform again. */
export function withoutCheck(stored: GuardrailStoredPolicy, checkId: string): GuardrailStoredPolicy {
  const checks = { ...stored.checks };
  delete checks[checkId];
  return { directions: { ...stored.directions }, checks };
}

export function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
