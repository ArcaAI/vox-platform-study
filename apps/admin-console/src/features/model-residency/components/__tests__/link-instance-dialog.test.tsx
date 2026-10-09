import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { makeLoaded, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const linkAsync = vi.fn();
vi.mock('../../api', () => ({ useLinkRuntimeKey: () => ({ mutateAsync: linkAsync, isPending: false }) }));

import { LinkInstanceDialog } from '../link-instance-dialog';

const model = makeLoaded({
  aiModelId: null,
  name: 'gemma-4-e2b-it-qat@q4_0',
  modelRef: 'gemma-4-e2b-it-qat@q4_0',
  identity: {
    matched: false,
    runtimeKeys: [],
    reportedKey: 'gemma-4-e2b-it-qat@q4_0',
    candidates: [
      {
        aiModelId: 'id-strong',
        name: 'Gemma 4 E2B IT QAT',
        slug: 'lms-gemma-4-e2b',
        strength: 'strong',
        reason: 'Same key once the suffix is removed.',
      },
      { aiModelId: 'id-weak', name: 'Gemma 4 E4B IT QAT', slug: 'lms-gemma-4-e4b', strength: 'weak', reason: 'Different size.' },
    ],
  },
});
const service = makeService(model, { service: 'lm-studio', label: 'LM Studio' });

function renderDialog(onLinked = vi.fn(), onOpenChange = vi.fn()) {
  render(<LinkInstanceDialog open onOpenChange={onOpenChange} service={service} model={model} onLinked={onLinked} />);
  return { onLinked, onOpenChange };
}

beforeEach(() => {
  linkAsync.mockReset().mockResolvedValue({});
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('LinkInstanceDialog', () => {
  it('summarises the running instance and pre-selects the strong candidate', () => {
    renderDialog();
    expect(screen.getAllByText('gemma-4-e2b-it-qat@q4_0').length).toBeGreaterThan(0);
    expect((screen.getByRole('radio', { name: /Gemma 4 E2B IT QAT/ }) as HTMLInputElement).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Strong match')).toBeTruthy();
    expect(screen.getByText('Weak match')).toBeTruthy();
    expect(screen.getByText(/what changes/i)).toBeTruthy();
  });

  it('links the reported key to the selected catalogue model', async () => {
    const { onLinked, onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Gemma 4 E4B/ }));
    fireEvent.click(screen.getByRole('button', { name: /link instance/i }));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(linkAsync).toHaveBeenCalledWith({ service: 'lm-studio', runtimeKey: 'gemma-4-e2b-it-qat@q4_0', aiModelId: 'id-weak' });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('"None of these" closes without a call', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /none of these/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep unmatched/i }));
    expect(linkAsync).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Keep unmatched says so', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /none of these/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep unmatched/i }));
    expect(toast.success).toHaveBeenCalledWith('Left unmatched');
  });

  it('toasts a failure in the server’s words', async () => {
    linkAsync.mockRejectedValue(new Error('runtime key already linked to another model'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /link instance/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't link gemma-4-e2b-it-qat@q4_0: runtime key already linked to another model"),
    );
  });

  it('has no axe violations', async () => {
    renderDialog();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
