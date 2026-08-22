/**
 * AgentStepType enum parity guard — THREE-WAY: domain ⇔ database ⇔ Python harness.
 *
 * `AgentTrajectoryStep.stepType` is written by TWO independent producers:
 *
 *   - Substrate A (`HarnessDocWorkflow` / `ConsultationLoopWorkflow`), and
 *   - Substrate B (`WorkflowInterpreter`, one step per graph node).
 *
 * Both post through `POST /internal/harness/consultations/:id/trajectory`, whose DTO validates
 * `@IsEnum(AgentStepType)`. The post is FIRE-AND-FORGET, so a value the enum does not carry is
 * rejected 400 and the rejection is SILENTLY SWALLOWED — the trajectory simply never appears.
 *
 * That is exactly the bug this guard exists to prevent (TASK-789 finding C-9): the harness
 * declared `STEP_NODE = "NODE"` and shipped it on every interpreter node, while `AgentStepType`
 * had no `NODE` member — so every Substrate-B run's trace was dropped without a trace. The
 * domain⇔database halves both PASSED at the time, because both were missing it; only the
 * cross-language half catches this class of drift.
 *
 * To fix a failure, add the missing value to ALL THREE:
 *   - packages/database/src/prisma/db_main/agent-trajectory.prisma (+ an ADD VALUE migration)
 *   - packages/domains/src/enums/generated/AgentStepType.ts
 *   - apps/harness/src/harness/temporal/activities.py (the STEP_* vocabulary block)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentStepType as PrismaAgentStepType } from '@arcaai/database';
import { AgentStepType as DomainAgentStepType } from '../index';

const HARNESS_ACTIVITIES = join(__dirname, '../../../../../apps/harness/src/harness/temporal/activities.py');

/** Extract every `STEP_<NAME> = "<VALUE>"` literal from the harness step-type vocabulary. */
function pythonStepTypeValues(): string[] {
  const source = readFileSync(HARNESS_ACTIVITIES, 'utf8');
  return [...source.matchAll(/^STEP_[A-Z_]+\s*=\s*['"]([A-Z_]+)['"]/gm)].map((m) => m[1]);
}

describe('AgentStepType enum parity (domain ⇔ database ⇔ harness)', () => {
  const databaseValues = new Set<string>(Object.values(PrismaAgentStepType));
  const domainValues = new Set<string>(Object.values(DomainAgentStepType));

  it('every domain AgentStepType value exists in the database enum', () => {
    const missing = Object.values(DomainAgentStepType).filter((v) => !databaseValues.has(v));
    expect(
      missing,
      'Domain AgentStepType values missing from the database enum. Add each to ' +
        'agent-trajectory.prisma AND an ALTER TYPE "core"."AgentStepType" ADD VALUE migration: ' +
        missing.join(', '),
    ).toEqual([]);
  });

  it('every database AgentStepType value exists in the domain enum', () => {
    const missing = Object.values(PrismaAgentStepType).filter((v) => !domainValues.has(v));
    expect(
      missing,
      'Database AgentStepType values missing from the domain enum. Add each to ' +
        `packages/domains/src/enums/generated/AgentStepType.ts: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every harness STEP_* value the Python side emits exists in the domain enum', () => {
    const pythonValues = pythonStepTypeValues();

    // Guard the guard: if the extraction regex ever stops matching, this test would
    // vacuously pass and hide the very drift it exists to catch.
    expect(pythonValues.length, `No STEP_* constants extracted from ${HARNESS_ACTIVITIES}`).toBeGreaterThan(5);

    const missing = pythonValues.filter((v) => !domainValues.has(v));
    expect(
      missing,
      'The harness emits step types the AgentStepType enum does not carry. Every trajectory ' +
        'post using one is rejected 400 by @IsEnum and silently swallowed (fire-and-forget), so ' +
        `the trace vanishes. Add to the prisma enum + migration + domain enum: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
