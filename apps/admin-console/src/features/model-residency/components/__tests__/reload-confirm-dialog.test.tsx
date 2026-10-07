import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { makeLoaded, makeService } from './fixtures';
import { ReloadConfirmDialog } from '../reload-confirm-dialog';

afterEach(cleanup);

function renderDialog(model = makeLoaded(), options = { contextLength: 4096 }) {
  const onConfirm = vi.fn();
  const view = render(
    <ReloadConfirmDialog
      open
      onOpenChange={vi.fn()}
      service={makeService(model)}
      model={model}
      options={options}
      isPending={false}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, ...view };
}

describe('ReloadConfirmDialog', () => {
  it('idle model: confirms without a reason and says what will happen', () => {
    const { onConfirm } = renderDialog();
    expect(screen.getByText(/unloaded and loaded again with context length 4096/i)).toBeTruthy();
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('in-flight requests require a reason', () => {
    const base = makeLoaded();
    const { onConfirm } = renderDialog(makeLoaded({ residency: { ...base.residency!, inFlight: 3 } }));
    expect(screen.getByRole('alert').textContent).toMatch(/3 requests/);
    const button = screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('true');
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: ' roll profile ' } });
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith('roll profile');
  });

  it('a pinned model requires a reason', () => {
    const base = makeLoaded();
    renderDialog(makeLoaded({ keepPolicy: { ...base.keepPolicy, kind: 'always', label: 'Always loaded' } }));
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no axe violations', async () => {
    renderDialog();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
