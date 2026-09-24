/**
 * TASK-1004 §4.5 — configuration-time language warnings on the admin writes that decide which ASR
 * engine a tenant runs: assigning a SPEECH_TO_TEXT agent (tenant/department tier) and publishing
 * one. The write has already succeeded; `warnings[]` is advisory — never a block, never a re-route.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentTask } from '@arcaai/applications';
import { AgentAssignmentAdminController } from '../agent-assignment-admin.controller';
import { AgentAdminController } from '../agent-admin.controller';

const WARNING = {
  code: 'LANGUAGE_MODE_DEGRADED',
  agentSlug: 'platform-transcription',
  mode: 'ml-en',
  engine: 'WHISPER_CPP',
  level: 'degraded',
  message: 'm',
};

describe('AgentAssignmentAdminController — warnings on an ASR assignment', () => {
  const build = (capability?: { warningsForAgent: ReturnType<typeof vi.fn> }) => {
    const assignments = {
      upsert: vi.fn(async (dto: { task: AgentTask; agentSlug: string }) => ({
        id: 'a-1',
        tenantId: 't-1',
        task: dto.task,
        agentSlug: dto.agentSlug,
        version: 2,
      })),
    };
    return { controller: new AgentAssignmentAdminController(assignments as never, capability as never), assignments };
  };

  it('POST: a SPEECH_TO_TEXT assignment carries the primary engine’s warnings for the tenant', async () => {
    const capability = { warningsForAgent: vi.fn().mockResolvedValue([WARNING]) };
    const { controller } = build(capability);
    const out = await controller.create({ scope: 'TENANT', task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription' } as never);
    expect(capability.warningsForAgent).toHaveBeenCalledWith('t-1', 'platform-transcription');
    expect(out).toMatchObject({ id: 'a-1', warnings: [WARNING] });
  });

  it('PATCH: the same, after the OCC write', async () => {
    const capability = { warningsForAgent: vi.fn().mockResolvedValue([WARNING]) };
    const { controller, assignments } = build(capability);
    const out = await controller.update(
      { scope: 'DEPARTMENT', scopeId: 'd-1', task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription' } as never,
      1,
    );
    expect(assignments.upsert).toHaveBeenCalledWith(expect.anything(), 1);
    expect(out.warnings).toEqual([WARNING]);
  });

  it('a non-ASR assignment is not judged and carries no warnings', async () => {
    const capability = { warningsForAgent: vi.fn() };
    const { controller } = build(capability);
    const out = await controller.create({ scope: 'TENANT', task: AgentTask.TEXT_GENERATION, agentSlug: 'soap' } as never);
    expect(capability.warningsForAgent).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('warnings');
  });

  it('no capability wired → the response is unchanged', async () => {
    const { controller } = build(undefined);
    const out = await controller.create({ scope: 'TENANT', task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'x' } as never);
    expect(out).not.toHaveProperty('warnings');
  });
});

describe('AgentAdminController — warnings on publishing an ASR agent', () => {
  const build = (task: AgentTask, capability = { warningsForAgent: vi.fn().mockResolvedValue([WARNING]) }) => {
    const agentService = { publish: vi.fn(async () => ({ id: 'ag-1', tenantId: 't-1', slug: 'platform-transcription', task, version: 3 })) };
    return { controller: new AgentAdminController(agentService as never, capability as never), capability };
  };

  it('a SPEECH_TO_TEXT publish carries warnings', async () => {
    const { controller, capability } = build(AgentTask.SPEECH_TO_TEXT);
    const out = await controller.publish('ag-1', {} as never);
    expect(capability.warningsForAgent).toHaveBeenCalledWith('t-1', 'platform-transcription');
    expect(out).toMatchObject({ id: 'ag-1', warnings: [WARNING] });
  });

  it('any other task is not judged', async () => {
    const { controller, capability } = build(AgentTask.TEXT_GENERATION);
    const out = await controller.publish('ag-1', {} as never);
    expect(capability.warningsForAgent).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('warnings');
  });
});
