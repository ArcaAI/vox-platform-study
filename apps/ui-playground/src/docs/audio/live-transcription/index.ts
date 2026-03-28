import type { DocRegistry } from '@/features/doc-panel/types';
import codeSwitching from './code-switching.md?raw';
import language from './language.md?raw';
import localAiModel from './local-ai-model.md?raw';
import micSources from './mic-sources.md?raw';
import noiseCancellation from './noise-cancellation.md?raw';
import processingMethods from './processing-methods.md?raw';
import speakerDiarization from './speaker-diarization.md?raw';
import vad from './vad.md?raw';

export default {
  'mic-sources': { content: micSources },
  'processing-methods': { content: processingMethods },
  'local-ai-model': { content: localAiModel },
  language: { content: language },
  'noise-cancellation': { content: noiseCancellation },
  vad: { content: vad },
  'speaker-diarization': { content: speakerDiarization },
  'code-switching': { content: codeSwitching },
} satisfies DocRegistry;
