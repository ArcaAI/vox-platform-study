/** TASK-1057 — publishing a document-template shape reads `documentTemplate.update` and sends `changeReason`. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ShapeEditor } from '../shape-editor';
import { soapStarterShape } from '../../api/types';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], publish: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  getJson: vi.fn(async () => ({ items: mocks.rows })),
}));
vi.mock('../../api/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/hooks')>()),
  usePublishDocumentTemplate: () => ({ mutate: mocks.publish, isPending: false, error: null }),
}));

const row = (mode: 'required' | 'not-required') => ({ actionId: 'documentTemplate.update', kind: 'reason', mode, locked: false });
const publishButton = () => screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;

function renderEditor() {
  renderWithProviders(<ShapeEditor templateId="dt-1" shape={soapStarterShape()} onShapeChange={vi.fn()} onPublished={vi.fn()} />);
}

beforeEach(() => mocks.publish.mockReset());
afterEach(cleanup);

describe('ShapeEditor — documentTemplate.update policy', () => {
  it('required: Publish waits for a reason and sends it', async () => {
    mocks.rows = [row('required')];
    renderEditor();
    await screen.findByText('Required. Recorded in the audit log.');
    expect(publishButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Change reason/), { target: { value: 'add meds section' } });
    await waitFor(() => expect(publishButton().disabled).toBe(false));
    fireEvent.click(publishButton());
    expect(mocks.publish.mock.calls[0][0].body.changeReason).toBe('add meds section');
  });

  it('not required: Publish works without a reason', async () => {
    mocks.rows = [row('not-required')];
    renderEditor();
    await screen.findByText('Recorded in the audit log when given.');
    fireEvent.click(publishButton());
    expect(mocks.publish.mock.calls[0][0].body.changeReason).toBeUndefined();
  });
});
