/**
 * TASK-1019 final review I11 — the edit form is READ-ONLY while the row is
 * DOWNLOADING or UNREGISTERING.
 *
 * Every download heartbeat bumps the row's `_version`, so a PATCH with the
 * drawer's If-Match could only ever 412 while a download runs. The form says so
 * up front instead: fields and Save are disabled with a visible reason, the
 * drawer re-reads the row while it is mid-flight, and once the row settles the
 * form re-enables — seeded from the SETTLED row (the worker writes fields such
 * as the bucket prefix, which a stale form would otherwise send back).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AiModel, ModelLifecycleStatus } from '../../api/types';
import { ModelFormSheet } from '../model-form-sheet';
import { BASE_MODEL, lifecycle, stubFetch } from './fixtures.task1019';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Disabled by its own attribute OR by an ancestor `<fieldset disabled>` (HTML
 * semantics; happy-dom's `:disabled` and the `.disabled` property reflect only
 * the former).
 */
function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled') || element.closest('fieldset[disabled]') !== null;
}

function rowIn(status: ModelLifecycleStatus, patch: Partial<AiModel> = {}): AiModel {
  return { ...BASE_MODEL, lifecycle: lifecycle(status), ...patch };
}

/** Serves `current()` for the row reads (and a neutral job state for the publish panel). */
function serve(current: () => AiModel) {
  return stubFetch((url) =>
    url.endsWith('/download')
      ? Response.json({ status: 'DOWNLOADED', localPath: null })
      : Response.json(current(), { headers: { etag: `"${current().version}"` } }),
  );
}

async function openEditDrawer() {
  renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);
  const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
  await within(dialog).findByDisplayValue(BASE_MODEL.name);
  return dialog;
}

describe('ModelFormSheet — read-only while the row is mid-flight (I11)', () => {
  it.each([
    ['DOWNLOADING', 'Editing is unavailable while the model is downloading.'],
    ['UNREGISTERING', 'Editing is unavailable while the model is being unregistered.'],
  ] as const)('%s: every field and Save are disabled, with the reason shown next to Save', async (status, reason) => {
    serve(() => rowIn(status));
    const dialog = await openEditDrawer();

    const notice = within(dialog).getByText(reason);
    expect(notice).toBeDefined();
    expect(isDisabled(within(dialog).getByLabelText(/^name/i))).toBe(true);
    expect(isDisabled(within(dialog).getByLabelText(/^slug/i))).toBe(true);
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBe(notice.id);

    // Belt and braces: a widget that ignores the fieldset (a Radix Select opens
    // on pointerdown) still cannot change the form's values.
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Changed while locked' } });
    expect(within(dialog).queryByDisplayValue('Changed while locked')).toBeNull();
  });

  it('a settled row is editable and shows no lock notice', async () => {
    serve(() => rowIn('SERVING'));
    const dialog = await openEditDrawer();

    expect(within(dialog).queryByText(/Editing is unavailable/)).toBeNull();
    expect(isDisabled(within(dialog).getByLabelText(/^name/i))).toBe(false);
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-reads the row while DOWNLOADING and re-enables once it settles — seeded from the settled row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = rowIn('DOWNLOADING', { bucketPrefix: null, version: 4 });
    serve(() => current);
    const dialog = await openEditDrawer();
    expect(isDisabled(within(dialog).getByLabelText(/^name/i))).toBe(true);

    // The worker finishes: the row settles with the bucket prefix it wrote.
    current = rowIn('DOWNLOADED', { bucketPrefix: 'whisper-ml-en/f16-fedcba987654/', version: 9 });
    await vi.advanceTimersByTimeAsync(5_100);

    await waitFor(() => expect(isDisabled(within(dialog).getByLabelText(/^name/i))).toBe(false));
    expect(within(dialog).queryByText(/Editing is unavailable/)).toBeNull();
    expect(within(dialog).getByDisplayValue('whisper-ml-en/f16-fedcba987654/')).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no axe violations while locked', async () => {
    serve(() => rowIn('DOWNLOADING'));
    const dialog = await openEditDrawer();

    expect(await axe(dialog)).toHaveNoViolations();
  });
});
