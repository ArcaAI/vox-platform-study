/**
 * The moderation timeouts NEST: text → guardrail → judge.
 *
 * `apps/text` asks guardrail to validate every prompt; guardrail answers by
 * delegating an LLM judgement back to text's judge lane on one shared GPU.
 * Measured over three days (n ≈ 695 judge calls): p50 2.9 s, p90 13.6 s,
 * p99 50.6 s, max 60 s. With text's per-attempt timeout at 10 s, text abandoned
 * about one validation in ten and sent it again while guardrail's judgement was
 * still running — nothing cancels across the hop — stacking up to three judges on
 * the GPU.
 *
 * The rule: the CALLER's deadline outlasts the callee's worst case. Here that is
 *
 *   text.externalGuardrail.timeoutS ≥ admission wait
 *                                    + guardrail.judge.timeoutSeconds × judge attempts
 *                                    + judge retry backoff
 *                                    + slack
 *
 * Both timeouts are descriptors in this package, so their defaults are imported.
 * The attempt count, backoff and admission wait are guardrail's `JudgePolicy` /
 * `TransportPolicy` contracts, read as SOURCE (this package cannot import Python).
 * The seeded SYSTEM row is checked too, because a fresh deployment serves the
 * seeded `value`, not the descriptor default. Each service pins its own bootstrap
 * floor to the same numbers (`test_external_guardrail_budget.py` in apps/text,
 * `test_judge_timeout_budget.py` in apps/guardrail).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_JUDGE_DEFAULTS, GUARDRAIL_JUDGE_TIMEOUT_KEY } from '../descriptors/guardrail-judge.descriptors';
import { TEXT_GUARDRAIL_POSTURE_DEFAULTS } from '../descriptors/text-provider-connections.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const GUARDRAIL_CONFIG = resolve(REPO, 'apps/guardrail/src/guardrail/core/config.py');
const SEED_FILE = resolve(REPO, 'packages/database/src/prisma/db_main/seed/11-global-setting.ts');

const TEXT_TIMEOUT_KEY = 'text.externalGuardrail.timeoutS';

/** Resolution, serialisation and scheduling on top of the declared waits. */
const SLACK_S = 5;

/** A literal `field: int|float = N` default inside one pydantic `BaseModel` class. */
function pythonPolicyDefault(cls: string, field: string): number {
  const source = readFileSync(GUARDRAIL_CONFIG, 'utf8');
  const block = new RegExp(`\\nclass ${cls}\\(BaseModel\\):([\\s\\S]*?)(?=\\nclass |$)`).exec(source);
  expect(block, `guardrail ${cls} is gone from core/config.py`).not.toBeNull();
  const match = new RegExp(`\\n\\s+${field}: (?:int|float) = ([0-9_.]+)`).exec(block![1]!);
  expect(match, `guardrail ${cls}.${field} is no longer a literal default`).not.toBeNull();
  return Number(match![1]!.replace(/_/g, ''));
}

/** Every seeded row for `key`, as `{ value, defaultValue }` (same window read as the other seed-parity tests). */
function seededRows(key: string): Array<{ value: string; defaultValue: string }> {
  const source = readFileSync(SEED_FILE, 'utf8');
  const rows: Array<{ value: string; defaultValue: string }> = [];
  for (const match of source.matchAll(new RegExp(`key: '${key.replace(/\./g, '\\.')}',`, 'g'))) {
    const after = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
    const value = /\n\s*value: '([^']*)',/.exec(after);
    const defaultValue = /\n\s*defaultValue: '([^']*)',/.exec(after);
    if (value && defaultValue) rows.push({ value: value[1]!, defaultValue: defaultValue[1]! });
  }
  return rows;
}

function innerWorstCaseS(judgeTimeoutS: number): number {
  const attempts = pythonPolicyDefault('JudgePolicy', 'max_attempts');
  const backoffS = pythonPolicyDefault('JudgePolicy', 'retry_backoff_s');
  const admissionS = pythonPolicyDefault('TransportPolicy', 'max_queue_wait_s');
  let backoffTotal = 0;
  for (let n = 1; n < attempts; n += 1) backoffTotal += backoffS * n;
  return admissionS + judgeTimeoutS * attempts + backoffTotal;
}

describe('text → guardrail → judge timeouts nest', () => {
  const judgeTimeoutS = GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY];

  it('the judge makes one attempt: a timed-out judgement is still running, so it is not retried', () => {
    expect(pythonPolicyDefault('JudgePolicy', 'max_attempts')).toBe(1);
  });

  it("text's default moderation deadline outlasts one guardrail validation", () => {
    const textTimeoutS = TEXT_GUARDRAIL_POSTURE_DEFAULTS[TEXT_TIMEOUT_KEY];
    expect(textTimeoutS).toBeGreaterThanOrEqual(innerWorstCaseS(judgeTimeoutS) + SLACK_S);
  });

  it('the registered descriptors carry those same defaults', () => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(TEXT_TIMEOUT_KEY).default).toBe(TEXT_GUARDRAIL_POSTURE_DEFAULTS[TEXT_TIMEOUT_KEY]);
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(GUARDRAIL_JUDGE_TIMEOUT_KEY).default).toBe(judgeTimeoutS);
  });

  it('the values sized against the measured p99 (50.6 s)', () => {
    expect(judgeTimeoutS).toBe(90); // TASK-1059 OD-6 (was 60): the text judge lane queues up to 30 s
    expect(TEXT_GUARDRAIL_POSTURE_DEFAULTS[TEXT_TIMEOUT_KEY]).toBe(120);
    expect(TEXT_GUARDRAIL_POSTURE_DEFAULTS['text.externalGuardrail.maxRetries']).toBe(2);
  });

  it('the seeded SYSTEM row — what a fresh deployment actually serves — matches the default and nests', () => {
    const rows = seededRows(TEXT_TIMEOUT_KEY);
    expect(rows.length, 'the seed no longer declares the text moderation timeout').toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.value)).toBe(TEXT_GUARDRAIL_POSTURE_DEFAULTS[TEXT_TIMEOUT_KEY]);
      expect(Number(row.defaultValue)).toBe(TEXT_GUARDRAIL_POSTURE_DEFAULTS[TEXT_TIMEOUT_KEY]);
    }
  });

  it('a seeded judge timeout, if one is ever added, still nests inside the seeded text timeout', () => {
    const textRow = seededRows(TEXT_TIMEOUT_KEY)[0];
    for (const row of seededRows(GUARDRAIL_JUDGE_TIMEOUT_KEY)) {
      expect(Number(textRow!.value)).toBeGreaterThanOrEqual(innerWorstCaseS(Number(row.value)) + SLACK_S);
    }
  });
});
