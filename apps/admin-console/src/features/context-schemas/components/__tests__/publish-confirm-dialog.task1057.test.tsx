/**
 * TASK-1057 — the publish dialog follows `contextSchema.publish` (change reason) and
 * `contextSchema.publishImpact` (the downstream-impact checkbox).
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PublishConfirmDialog } from '../publish-confirm-dialog';

const policy = vi.hoisted(() => ({
  items: [] as { actionId: string; kind: string; mode: string; locked: boolean }[],
}));
vi.mock('@/shared/api', async () => ({
  ...(await vi.importActual<object>('@/shared/api')),
  getJson: vi.fn(async () => ({ items: policy.items })),
}));

afterEach(cleanup);


function renderDialog(onConfirm = vi.fn(), impact: unknown = null) {
  renderWithProviders(
    <PublishConfirmDialog
      open
      onOpenChange={vi.fn()}
      nextVersion={2}
      currentVersion={1}
      additions={[]}
      impact={impact as never}
      breakingChanges={null}
      onConfirm={onConfirm}
      isPending={false}
    />,
  );
  return onConfirm;
}

describe('PublishConfirmDialog policy', () => {
  it('change reason required: Publish stays disabled until typed, and the reason is sent', async () => {
    policy.items = [{ actionId: 'contextSchema.publish', kind: 'reason', mode: 'required', locked: false }];
    const onConfirm = renderDialog();
    const publish = (await screen.findAllByRole('button')).find((b) => /publish/i.test(b.textContent ?? '')) as HTMLButtonElement;
    await waitFor(() => expect(publish.disabled).toBe(true));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add referral kind' } });
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ changeReason: 'add referral kind' }));
  });

  it('change reason not-required: publishes without one', async () => {
    policy.items = [{ actionId: 'contextSchema.publish', kind: 'reason', mode: 'not-required', locked: false }];
    const onConfirm = renderDialog();
    await screen.findByText('(optional)');
    const publish = screen.getAllByRole('button').find((b) => /publish/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    expect(onConfirm).toHaveBeenCalledWith(expect.not.objectContaining({ changeReason: expect.anything() }));
  });
});
