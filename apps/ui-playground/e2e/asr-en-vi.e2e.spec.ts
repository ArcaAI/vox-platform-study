import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTranscriptionTest } from './e2e-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PIPELINE_NAME = 'ASR EN-VI';
const GROUND_TRUTH_PATH = path.resolve(__dirname, 'fixtures', 'asr-en-vi.txt');
const AUDIO_DURATION_SECONDS = 10;
const SPEECH_START_SECONDS = 0.5;
const SPEECH_END_SECONDS = 10;

test('ASR EN-VI: realtime transcription accuracy meets quality thresholds', async ({ page }) => {
  await runTranscriptionTest({
    page,
    pipelineName: PIPELINE_NAME,
    groundTruthPath: GROUND_TRUTH_PATH,
    audioDurationSeconds: AUDIO_DURATION_SECONDS,
    speechStartSeconds: SPEECH_START_SECONDS,
    speechEndSeconds: SPEECH_END_SECONDS,
  });
});
