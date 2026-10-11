/**
 * TASK-1061 OD-3 — the composed-prompt record states, WITHOUT a decrypt, whether an exemplar set
 * was attached to the prompt it describes.
 *
 *  1. A record whose prompt carried an exemplar set names the set's fingerprint and size in the
 *     record's metadata, and ONE info line `prompt.exemplars.attached` says so — never any text.
 *  2. Every other record (pre-summary, live) states `exemplarSetVersion: null`, so an audit can
 *     prove no exemplar set reached it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { SysEventType } from '@arcaai/domains';
import { ComposedPromptRecorder } from '../composed-prompt.recorder';

const TENANT = 'tenant-1061';
const cls = { get: vi.fn(() => TENANT), set: vi.fn(), run: vi.fn(async (_options: unknown, work: () => unknown) => work()) };
const events = { emit: vi.fn() };
const secrets = { encrypt: vi.fn(), decrypt: vi.fn(), getPhiTransitKeyName: () => 'hope-phi' };
const repository = {
  encryptText: vi.fn(async (_s: unknown, plaintext: string) => ({ ciphertext: Buffer.from(`ct:${plaintext.length}`), keyVersion: 3 })),
  create: vi.fn(async (entity: { id?: string }) => ({ ...entity, id: 'rec-1' })),
};
const base = {
  tenantId: TENANT,
  consultationId: 'c-1',
  agentSlug: 'general-medicine-summarization',
  provider: 'lmstudio',
  locality: 'local' as const,
  system: 'SYSTEM metformin 1000 mg',
  user: 'USER amlodipine 5 mg',
};

const recorder = () => new ComposedPromptRecorder(repository as never, events as never, cls as never, secrets as never);

/** The `data` of the ResourceCreated sys-event — the record's audited metadata. */
function recordedMetadata(): Record<string, unknown> {
  const call = events.emit.mock.calls.find(([type]) => type === SysEventType.ResourceCreated);
  expect(call, 'no ResourceCreated event').toBeDefined();
  return (call![1] as { data: Record<string, unknown> }).data;
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('a prompt that carried an exemplar set', () => {
  it('names the set fingerprint and size in the record metadata and logs ONE text-free info line', async () => {
    await recorder().write({ ...base, phase: 'finalize', exemplarSetVersion: 'k3x9', exemplarCount: 2 });

    expect(recordedMetadata()).toMatchObject({ phase: 'finalize', exemplarSetVersion: 'k3x9', exemplarCount: 2 });
    const lines = log.mock.calls.filter(([entry]) => (entry as { message?: string })?.message === 'prompt.exemplars.attached');
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({ message: 'prompt.exemplars.attached', phase: 'finalize', consultationId: 'c-1', setVersion: 'k3x9', count: 2 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/metformin|amlodipine/);
  });
});

describe('a pre-summary or live prompt', () => {
  it.each(['pre-summary', 'live'])('%s: records that NO exemplar set was attached, and logs nothing about exemplars', async (phase) => {
    await recorder().write({ ...base, phase });

    const metadata = recordedMetadata();
    expect(metadata).toHaveProperty('exemplarSetVersion', null);
    expect(metadata).toHaveProperty('exemplarCount', 0);
    expect(log.mock.calls.some(([entry]) => (entry as { message?: string })?.message === 'prompt.exemplars.attached')).toBe(false);
  });
});
