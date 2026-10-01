import { describe, expect, it, vi } from 'vitest';

import { CheckpointExportModule } from '../export.module';
import { CheckpointExportProcessor } from '../export.processor';

const cls = { run: (fn: () => unknown) => fn(), set: () => undefined, get: () => undefined, isActive: () => false } as any;

describe('CheckpointExportProcessor', () => {
  it('routes create → export runner and verify-upload → verify runner; refuses an unknown kind', async () => {
    const exportRunner = { run: vi.fn(async () => undefined) };
    const verifyRunner = { run: vi.fn(async () => undefined) };
    const p = new CheckpointExportProcessor(exportRunner, verifyRunner, cls);
    await p.process({ id: '1', data: { kind: 'create', checkpointId: 'c1', tenantId: 't' } } as any);
    await p.process({ id: '2', data: { kind: 'verify-upload', checkpointId: 'c2', tenantId: 't' } } as any);
    expect(exportRunner.run).toHaveBeenCalledWith('c1');
    expect(verifyRunner.run).toHaveBeenCalledWith('c2');
    await expect(p.process({ id: '3', data: { kind: 'restore', checkpointId: 'c3', tenantId: 't' } } as any)).rejects.toThrow('unknown checkpoint job kind');
    expect(CheckpointExportModule).toBeDefined();
  });
});
