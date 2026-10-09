/**
 * TASK-1055 wave 3 (G3) — tts is a residency-controlled service: the console labels it
 * "Text-to-speech" (legend + its own swatch) and shows it as a service tab beside the others.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ResidencyServiceId } from '../../api/types';
import { SERVICE_LEGEND_LABEL, SERVICE_SWATCH } from '../gpu-memory-bar';
import { ModelsTable } from '../models-table';
import { LMS, makeDevice, makeModel, makeService, NLP, STT, WORKER } from './residency-test-data';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TTS = makeService({
  service: 'tts' satisfies ResidencyServiceId,
  label: 'Text-to-speech',
  runsOn: 'cpu',
  models: [makeModel({ aiModelId: 'kokoro-id', name: 'Kokoro', modelRef: 'kokoro', format: 'PYTORCH' })],
});

describe('the tts service in the console', () => {
  it('has a "Text-to-speech" legend label and a swatch of its own', () => {
    expect(SERVICE_LEGEND_LABEL.tts).toBe('Text-to-speech');
    const others = ['stt', 'stt-worker', 'lm-studio', 'nlp'].map((s) => SERVICE_SWATCH[s]);
    expect(SERVICE_SWATCH.tts).toBeDefined();
    expect(others).not.toContain(SERVICE_SWATCH.tts);
  });

  it('is a service tab and a group in the models table', () => {
    renderWithProviders(
      <ModelsTable
        services={[STT, WORKER, LMS, NLP, TTS]}
        devices={[makeDevice()]}
        pendingKeys={new Set()}
        onLoad={vi.fn()}
        onUnload={vi.fn()}
        onLink={vi.fn()}
        onOpenDrawer={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /Text-to-speech/ }).textContent).toBe('Text-to-speech 1');
    const headers = screen.getAllByRole('rowheader').map((cell) => cell.getAttribute('data-service'));
    expect(headers).toEqual(['stt', 'stt-worker', 'lm-studio', 'nlp', 'tts']);
  });
});
