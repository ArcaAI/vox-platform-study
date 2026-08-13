import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_FETCH_DEBOUNCE_MS, PipelinePicker } from '../PipelinePicker';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PIPELINE_ROW = { id: 'p1', name: 'Default STT', slug: 'default-stt', isDefault: true };

describe('PipelinePicker', () => {
  it('renders a Select of real pipelines once the fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [PIPELINE_ROW] }));

    render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="key" value="" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
  });

  it('falls back to the free-text input on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="key" value="" onChange={vi.fn()} />);

    const input = await screen.findByLabelText('Pipeline ID');
    expect(input).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('falls back to the free-text input on a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="key" value="" onChange={vi.fn()} />);

    expect(await screen.findByLabelText('Pipeline ID')).toBeInTheDocument();
  });

  it('falls back to the free-text input when the pipeline list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="key" value="" onChange={vi.fn()} />);

    expect(await screen.findByLabelText('Pipeline ID')).toBeInTheDocument();
  });

  it('typing in the free-text fallback calls onChange with the raw value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="key" value="" onChange={onChange} />);

    const input = await screen.findByLabelText('Pipeline ID');
    await user.type(input, 'x');

    expect(onChange).toHaveBeenCalledWith('x');
  });

  // The Connection tab re-renders on
  // every keystroke, so an undebounced effect sent a partially-typed API key to
  // the gateway once per character. Never a correctness race — the stale-response
  // guard already handled that — but real credential leakage into gateway logs.
  it('debounces the fetch so a partially-typed API key is never sent', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [PIPELINE_ROW] });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey="s" value="" onChange={vi.fn()} />);

    // Type four more characters, each well inside the debounce window.
    for (const key of ['se', 'sec', 'secr', 'secret']) {
      rerender(<PipelinePicker apiEndpoint="http://localhost:8868" apiKey={key} value="" onChange={vi.fn()} />);
      act(() => {
        vi.advanceTimersByTime(PIPELINE_FETCH_DEBOUNCE_MS / 4);
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // Settle: exactly one request, carrying only the final value.
    await act(async () => {
      vi.advanceTimersByTime(PIPELINE_FETCH_DEBOUNCE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ 'x-api-key': 'secret' }) });
  });

  it('skips the fetch and goes straight to free text when credentials are empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PipelinePicker apiEndpoint="" apiKey="" value="" onChange={vi.fn()} />);

    expect(await screen.findByLabelText('Pipeline ID')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
