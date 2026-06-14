import { describe, it, expect, vi } from 'vitest';
import { approveNote } from '../clinical-workspace.api';
import { WORKSPACE_ENDPOINTS } from '../../constants';

function fakeClient() {
  return { post: vi.fn().mockResolvedValue({ approvalStatus: 'SIGNED' }) };
}

// TASK-355 Phase D Slice 6a — Q4 one-click safety-flag override wire contract.
describe('approveNote — overrideSafetyFlag wire contract (TASK-355 Q4)', () => {
  it('posts an empty body when no override is requested', async () => {
    const client = fakeClient();

    await approveNote(client as never, 'c-1', 'ctx-1');

    expect(client.post).toHaveBeenCalledWith(WORKSPACE_ENDPOINTS.summaryApprove('c-1', 'ctx-1'), {});
  });

  it('posts { overrideSafetyFlag: true } when override is requested', async () => {
    const client = fakeClient();

    await approveNote(client as never, 'c-1', 'ctx-1', { overrideSafetyFlag: true });

    expect(client.post).toHaveBeenCalledWith(WORKSPACE_ENDPOINTS.summaryApprove('c-1', 'ctx-1'), { overrideSafetyFlag: true });
  });
});
