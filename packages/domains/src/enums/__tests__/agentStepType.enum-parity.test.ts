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
 * That is exactly the bug this guard exists to prevent: the harness
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
import { AgentStepType as PrismaAgentStepType, AgentStepStatus as PrismaAgentStepStatus } from '@arcaai/database';
import { AgentStepType as DomainAgentStepType, AgentStepStatus as DomainAgentStepStatus } from '../index';

const HARNESS_ACTIVITIES = join(__dirname, '../../../../../apps/harness/src/harness/temporal/activities.py');
const HARNESS_INTERPRETER_MODELS = join(__dirname, '../../../../../apps/harness/src/harness/temporal/interpreter/models.py');

/** Extract every `STEP_<NAME> = "<VALUE>"` literal from the harness step-type vocabulary. */
function pythonStepTypeValues(): string[] {
  const source = readFileSync(HARNESS_ACTIVITIES, 'utf8');
  return [...source.matchAll(/^STEP_[A-Z_]+\s*=\s*['"]([A-Z_]+)['"]/gm)].map((m) => m[1]);
}

/** Extract every `STATUS_<NAME> = "<VALUE>"` literal — the terminal step-status vocabulary. */
function pythonStepStatusValues(): string[] {
  const source = readFileSync(HARNESS_ACTIVITIES, 'utf8');
  return [...source.matchAll(/^STATUS_[A-Z_]+\s*=\s*['"]([A-Z_]+)['"]/gm)].map((m) => m[1]);
}

/**
 * The interpreter's per-node outcome vocabulary (`interpreter/models.py`). This is the SOURCE of
 * the C-10 drift: the interpreter computes `DEGRADED` per node, but if `AgentStepStatus` cannot
 * carry it, a degraded node is persisted as OK or ERROR and the distinction is lost before any
 * reader sees it — so a graph that PARTIALLY degrades becomes indistinguishable from one that
 * succeeded or one that failed outright. That is the single outcome a workflow author most needs
 * to see, and the one the interpreter is deliberately designed to produce rather than crash.
 */
function pythonNodeStatusValues(): string[] {
  const source = readFileSync(HARNESS_INTERPRETER_MODELS, 'utf8');
  const line = /^NodeStatus\s*=\s*Literal\[(.*?)\]/m.exec(source);
  if (!line) return [];
  return [...line[1].matchAll(/['"]([A-Z_]+)['"]/g)].map((m) => m[1]);
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

describe('AgentStepStatus enum parity (domain ⇔ database ⇔ harness) —  C-10', () => {
  const databaseValues = new Set<string>(Object.values(PrismaAgentStepStatus));
  const domainValues = new Set<string>(Object.values(DomainAgentStepStatus));

  it('every domain AgentStepStatus value exists in the database enum', () => {
    const missing = Object.values(DomainAgentStepStatus).filter((v) => !databaseValues.has(v));
    expect(missing, `Add to agent-trajectory.prisma + an ADD VALUE migration: ${missing.join(', ')}`).toEqual([]);
  });

  it('every database AgentStepStatus value exists in the domain enum', () => {
    const missing = Object.values(PrismaAgentStepStatus).filter((v) => !domainValues.has(v));
    expect(missing, `Add to packages/domains/src/enums/generated/AgentStepStatus.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('every harness STATUS_* value the Python side emits exists in the domain enum', () => {
    const pythonValues = pythonStepStatusValues();
    expect(pythonValues.length, `No STATUS_* constants extracted from ${HARNESS_ACTIVITIES}`).toBeGreaterThan(1);

    const missing = pythonValues.filter((v) => !domainValues.has(v));
    expect(missing, `The harness emits step statuses the enum does not carry: ${missing.join(', ')}`).toEqual([]);
  });

  it('every interpreter NodeStatus outcome is representable as a persisted step status', () => {
    const nodeStatuses = pythonNodeStatusValues();
    expect(nodeStatuses.length, `No NodeStatus Literal extracted from ${HARNESS_INTERPRETER_MODELS}`).toBeGreaterThan(2);

    // SUCCEEDED/FAILED are the interpreter's names for OK/ERROR, which the enum already carries.
    const ALIASES: Record<string, string> = { SUCCEEDED: 'OK', FAILED: 'ERROR' };
    const missing = nodeStatuses.map((s) => ALIASES[s] ?? s).filter((v) => !domainValues.has(v));

    expect(
      missing,
      'The interpreter computes per-node outcomes that cannot be PERSISTED, so they are silently ' +
        'collapsed into OK/ERROR and a partially-degraded graph reads as success or outright ' +
        `failure. Add to the prisma enum + migration + domain enum: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
