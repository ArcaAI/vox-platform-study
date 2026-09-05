/**
 * tier-1a is `@Optional()`, so it can be silently unwired.
 *
 * `IWorkflowAssignmentService` and `WorkflowDefinitionRepository` are optional
 * injections on `PromptResolutionService` because it is also constructed
 * positionally in background job processors and in a long tail of unit tests.
 * The cost of that is a failure mode with no symptom: drop the module import
 * and tier-1a stops resolving for every tenant, silently, with resolution
 * quietly degrading to the department column and the SYSTEM default. Nothing
 * throws and no test fails.
 *
 * This is that test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_SOURCE = readFileSync(join(__dirname, '..', 'prompt-resolution.service.module.ts'), 'utf8');

describe('PromptResolutionServiceModule', () => {
  it('imports WorkflowAssignmentServiceModule so the @Optional tier-1a resolver is actually provided', () => {
    expect(MODULE_SOURCE).toContain('WorkflowAssignmentServiceModule');
    expect(MODULE_SOURCE).toMatch(/imports:\s*\[[^\]]*WorkflowAssignmentServiceModule[^\]]*\]/);
  });

  it('imports CoreDatabaseModule so WorkflowDefinitionRepository is provided', () => {
    expect(MODULE_SOURCE).toMatch(/imports:\s*\[[^\]]*CoreDatabaseModule[^\]]*\]/);
  });

  // TASK-884 — the tag-selected agent tier has the SAME silent failure mode: unwired, a request
  // carrying `agentSelectorTags` resolves exactly like one that carried none, and nothing throws.
  it('imports AgentAssignmentServiceModule so the @Optional tag-selected agent tier is actually provided', () => {
    expect(MODULE_SOURCE).toMatch(/imports:\s*\[[^\]]*AgentAssignmentServiceModule[^\]]*\]/);
  });
});
