# @arcaai/types

Shared TypeScript type definitions for the HOPE platform, providing a single source of truth for interfaces and types used across all frontend applications and packages.

## Overview

The `@arcaai/types` package centralizes TypeScript type definitions used throughout the HOPE frontend ecosystem. It ensures type consistency across packages by providing shared interfaces for audio processing, transcription, medical workflows, model management, and more.

## Type Categories

- **Meeting** - Medical consultation session types
- **Audio** - Audio capture and processing types
- **Transcription** - Speech-to-text result and segment types
- **Diarization** - Speaker identification and labeling types
- **LLM** - Large language model integration types
- **Common** - Shared utility types
- **Storage** - File and object storage types
- **Voice Recognition** - Voice identification types
- **Speaker Mapping** - Speaker-to-role mapping types
- **VAD** - Voice activity detection types
- **Model Management** - ML model lifecycle types
- **Stepper** - Multi-step workflow types

## Usage

```typescript
import type { TranscriptionSegment, AudioConfig, MeetingSession } from '@arcaai/types';
```

## License

MIT
