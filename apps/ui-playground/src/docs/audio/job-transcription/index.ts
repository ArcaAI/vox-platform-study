import type { DocRegistry } from '@/features/doc-panel/types';
import language from './language.md?raw';
import batchTranscript from './batch-transcript.md?raw';

export default {
  'batch-transcript': { content: batchTranscript },
  language: { content: language },
} satisfies DocRegistry;
