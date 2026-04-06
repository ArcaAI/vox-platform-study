import { test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTranscriptionTest } from './e2e-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PIPELINE_NAME = 'ASR Malayalam';
const GROUND_TRUTH_PATH = path.resolve(__dirname, 'fixtures', 'asr_ml.txt');
const AUDIO_FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'asr_ml.wav');
const AUDIO_DURATION_SECONDS = 36; // placeholder
const SPEECH_START_SECONDS = 0; // placeholder
const SPEECH_END_SECONDS = 36; // placeholder

const fixturesExist = existsSync(AUDIO_FIXTURE_PATH) && existsSync(GROUND_TRUTH_PATH);

test('ASR Malayalam: realtime transcription accuracy meets quality thresholds', async ({ page }) => {
  test.skip(!fixturesExist, 'Skipping: asr_ml.wav or asr_ml.txt fixture files not found. Add them to fixtures/ to enable this test.');

  await runTranscriptionTest({
    page,
    pipelineName: PIPELINE_NAME,
    groundTruthPath: GROUND_TRUTH_PATH,
    audioDurationSeconds: AUDIO_DURATION_SECONDS,
    speechStartSeconds: SPEECH_START_SECONDS,
    speechEndSeconds: SPEECH_END_SECONDS,
  });
});
