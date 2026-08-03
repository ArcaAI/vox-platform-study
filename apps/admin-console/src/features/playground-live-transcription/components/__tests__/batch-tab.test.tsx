/**
 * BUG-014 — rule 11 §5: "disabled buttons need a visible reason (tooltip or
 * adjacent text)". `Upload & transcribe` is disabled until BOTH a file and a
 * pipeline exist; with the pipeline picker stalled, `pipelineId` stays null and
 * the control is permanently dead. The reason must be visible AND programmatically
 * associated with the button.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { BatchTab } from '../batch-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/api/hope/audio/transcription-jobs') {
        return Response.json({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });
      }
      throw new Error(`Unhandled fetch: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab(pipelineId: string | null) {
  return renderWithProviders(<BatchTab pipelineId={pipelineId} activeJobId={null} onActiveJobChange={vi.fn()} />);
}

function chooseFile() {
  const input = screen.getByLabelText(/audio file/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['RIFF'.repeat(64)], 'visit.wav', { type: 'audio/wav' })] } });
}

/** The visible text the disabled control points at, via aria-describedby. */
function accessibleReason(): string {
  const button = screen.getByRole('button', { name: /upload & transcribe/i });
  const id = button.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return document.getElementById(id as string)?.textContent ?? '';
}

describe('BatchTab upload control', () => {
  it('states that a pipeline is required when the picker produced none', () => {
    renderTab(null);
    chooseFile();

    expect((screen.getByRole('button', { name: /upload & transcribe/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(accessibleReason()).toMatch(/pipeline/i);
  });

  it('states that a file is required when none has been chosen', () => {
    renderTab('p-default');

    expect((screen.getByRole('button', { name: /upload & transcribe/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(accessibleReason()).toMatch(/audio file/i);
  });

  it('drops the reason once the control is actionable', () => {
    renderTab('p-default');
    chooseFile();

    const button = screen.getByRole('button', { name: /upload & transcribe/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});
