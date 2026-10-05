/**
 * TASK-982 §3.4.5 — `workflow.run.completed` envelope cross-language parity (TypeScript half).
 *
 * A pre-v2 `interpreter.emit_run_events` PRODUCED the envelope payload (TASK-1038 B1 retired
 * that producer — the harness writes run-protocol v2 events only, and the Python half of this
 * parity was retired with it); `WorkflowRunCompletionService`'s watcher (this repo,
 * `apps/api/src/modules/workflows/workflow-run-completion.service.ts`) CONSUMES it, through the
 * dependency-free leaf module `run-completed-counts.ts` imported below — never the service file
 * itself, so this root-level test does not drag in `ioredis`/`nestjs-cls`/NestJS decorators. It
 * still reads a LEGACY stream entry's payload, which is what `workflow-run-completed.fixture.json`
 * pins.
 *
 * This file asserts the consumer side: `runCompletedCountsFromPayload(expected)` extracts exactly
 * `input`'s counts, `undefined` for anything the payload omitted — never a fabricated zero.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCompletedCountsFromPayload } from '../../apps/api/src/modules/workflows/run-completed-counts';

interface FixtureCase {
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'workflow-run-completed.fixture.json'), 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

describe('workflow.run.completed envelope parity — consumer half', () => {
  it('the fixture declares at least the all-counts and the pre-TASK-982-shape cases', () => {
    expect(cases.map(([name]) => name)).toEqual(expect.arrayContaining(['allCountsPresent', 'noCountsPreTask982Shape', 'zeroCountsAreReal']));
  });

  it.each(cases)('%s: runCompletedCountsFromPayload(expected) extracts exactly input`s counts', (_name, { input, expected }) => {
    const counts = runCompletedCountsFromPayload(expected);
    expect(counts).toEqual({
      nodeCount: input.nodeCount,
      failedNodeCount: input.failedNodeCount,
      degradedNodeCount: input.degradedNodeCount,
      skippedNodeCount: input.skippedNodeCount,
    });
  });
});
