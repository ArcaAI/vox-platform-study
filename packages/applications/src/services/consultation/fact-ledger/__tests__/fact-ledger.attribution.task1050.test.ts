/**
 * TASK-1050 finding D — every fact-ledger extraction call names, for its guardrail evaluation, the
 * consultation, the segment / transcript items it placed in the `input` region (at the version
 * rendered), and the run key its `AiActivityRun` is recorded under.
 */
import { describe, expect, it, vi } from 'vitest';
import { FactLedgerService } from '../fact-ledger.service';
import { FACT_LEDGER_AGENT_SLUG } from '../fact-ledger.schema';

const TENANT = 'tenant-1';
const CID = 'consult-1';

const segment = (id: string, segmentSeq: number, content: string, version: number) => ({
  id,
  segmentSeq,
  encounterSeq: 1,
  speaker: 'Doctor',
  t0Ms: 1_000 * segmentSeq,
  content,
  currentVersionNumber: version,
});

describe('fact ledger — guardrail attribution on the extraction call', () => {
  it('passes consultation, input-region items and the run key to the invocation', async () => {
    const segments = [segment('seg-1', 1, 'Metformin 500 mg twice daily.', 3), segment('seg-2', 2, 'Allergic to penicillin.', 1)];
    const invokeText = vi.fn(async () => ({ text: JSON.stringify({ facts: [] }), model: 'm', provider: 'p', usage: null, promptFragments: null }));
    const service = new FactLedgerService(
      {
        findSegments: vi.fn(async () => segments),
        findTranscripts: vi.fn(async () => []),
        findEncounterArtifact: vi.fn(async () => null),
      } as never,
      {
        resolve: vi.fn(async () => ({
          slug: FACT_LEDGER_AGENT_SLUG,
          versionNumber: 1,
          agentVersionId: 'v1',
          agentId: 'a1',
          task: 'TEXT_GENERATION',
        })),
      } as never,
      { invokeText } as never,
      { upsertEncounterArtifact: vi.fn(async () => ({ contextItemId: 'ledger', versionNumber: 1 })) } as never,
      undefined,
      { record: vi.fn(async () => undefined) } as never,
    );

    await service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });

    const options = invokeText.mock.calls.at(-1)?.[4] as { attribution?: Record<string, unknown> } | undefined;
    expect(options?.attribution).toMatchObject({
      consultationId: CID,
      regionItems: {
        input: [
          { itemId: 'seg-1', itemVersion: 3 },
          { itemId: 'seg-2', itemVersion: 1 },
        ],
      },
      correlation: { runKey: expect.stringMatching(new RegExp(`:${CID}:e1-.*:0$`)) },
    });
  });

  it('marks the FACT_LEDGER it writes WARNED when an extraction call raised an outbound warning', async () => {
    const warning = {
      schemaVersion: 1,
      noticeId: 'n-1',
      type: 'guardrail.warning',
      direction: 'outbound',
      action: 'warn',
      checks: [],
      consultationId: CID,
      itemIds: [],
      messageKey: 'guardrail.warning.generic',
      defaultMessage: 'x',
      requiresAcknowledgement: true,
      resumable: false,
      policyVersion: 'pv-1',
      occurredAt: '2026-10-08T00:00:00.000Z',
    };
    const repo = {
      findSegments: vi.fn(async () => [segment('seg-1', 1, 'Metformin 500 mg twice daily.', 1)]),
      findTranscripts: vi.fn(async () => []),
      findEncounterArtifact: vi.fn(async () => null),
      findById: vi.fn(async (id: string) => ({ id, consultationId: CID, guardrailStatus: 'CLEAN' })),
      setGuardrailStatus: vi.fn(async () => undefined),
    };
    const service = new FactLedgerService(
      repo as never,
      { resolve: vi.fn(async () => ({ slug: FACT_LEDGER_AGENT_SLUG, versionNumber: 1, agentVersionId: 'v1', agentId: 'a1', task: 'TEXT_GENERATION' })) } as never,
      { invokeText: vi.fn(async () => ({ text: JSON.stringify({ facts: [] }), model: 'm', provider: 'p', usage: null, promptFragments: null, guardrailNotices: [warning] })) } as never,
      { upsertEncounterArtifact: vi.fn(async (input: { type: string }) => ({ contextItemId: input.type === 'FACT_LEDGER' ? 'ledger' : 'recap', versionNumber: 2 })) } as never,
      undefined,
      { record: vi.fn(async () => undefined) } as never,
    );

    await service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });

    expect(repo.setGuardrailStatus).toHaveBeenCalledTimes(1);
    expect(repo.setGuardrailStatus).toHaveBeenCalledWith('ledger', 'WARNED', undefined);
  });
});
