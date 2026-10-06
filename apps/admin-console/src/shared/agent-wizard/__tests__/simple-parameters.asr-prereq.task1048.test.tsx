/**
 * TASK-1048 — the notice must appear in the editor admins actually use. A tenant admin flips the
 * diarization / VAD switch in the SIMPLE editor; the model slugs are platform-managed, so the
 * editor says — at the moment of the flip — that the stage will use the platform default or be
 * skipped, and that transcription still runs.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AgentSimpleParameters } from '../simple-parameters';

const ASR = {
  id: 'asr', slug: 'asr', name: 'asr', description: null, taskType: 'AUTOMATIC_SPEECH_RECOGNITION', providerId: 'hope', provider: 'built-in',
  providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null,
  capabilities: { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: [] },
};

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('auth/session')) return Response.json({ user: { id: 'u', roles: [] }, effectiveIsElevated: false, isElevated: false });
      if (url.includes('ai-models/catalogue')) return Response.json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, usable: true, reason: null, modelCount: 1 }], models: [ASR] });
      return Response.json([]);
    }),
  );
}

function Host({ initial = {} }: { initial?: Record<string, unknown> }) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  return <AgentSimpleParameters task="SPEECH_TO_TEXT" modelId="asr" value={value} onChange={setValue} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentSimpleParameters — ASR prerequisite notices (TASK-1048)', () => {
  it('switching diarization on with no speaker model shows the notice', async () => {
    stub();
    renderWithProviders(<Host />);
    const diarization = await screen.findByLabelText('Speaker separation (diarization)');
    expect(screen.queryByTestId('asr-prereq-diarization')).toBeNull();
    fireEvent.click(diarization);
    expect(await screen.findByTestId('asr-prereq-diarization')).toBeTruthy();
    expect(screen.getByText(/transcription still runs/i)).toBeTruthy();
  });

  it('no notice when the agent names a speaker model', async () => {
    stub();
    renderWithProviders(<Host initial={{ audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } } }} />);
    await screen.findByLabelText('Speaker separation (diarization)');
    expect(screen.queryByTestId('asr-prereq-diarization')).toBeNull();
  });

  it('VAD on with no VAD model shows the VAD notice', async () => {
    stub();
    renderWithProviders(<Host initial={{ audioFrontEnd: { vad: { enabled: true } } }} />);
    expect(await screen.findByTestId('asr-prereq-vad')).toBeTruthy();
  });
});
