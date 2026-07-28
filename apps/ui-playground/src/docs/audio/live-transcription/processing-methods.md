## Processing Method

Selects where your audio gets transcribed: on your device using a local Whisper model, or on the backend via a WebSocket connection.

<!-- @section -->

### Options

| Option       | Description                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local AI** | Runs Whisper in-browser via WASM. Audio stays on-device. Supports VAD, noise cancellation, diarization, and code-switching. Requires a one-time model download. |
| **Backend**  | Streams audio to the backend over WebSocket. Server handles transcription and returns results in real-time. Lighter on device resources.                        |

<!-- @example -->

```tsx
import { useSTT } from '@arcaai/stt';

// Local AI — on-device Whisper
const stt = useSTT({
  track,
  features: {
    provider: 'local',
    modelId: 'whisper-base',
  },
  onTranscription: (result) => console.log(result.text),
});

// Backend — WebSocket streaming
const realtime = useRealtimeTranscription();
await realtime.start({ pipelineId: '81000000-0000-0000-0001-000000000001' });
```

<!-- @/example -->
<!-- @/section -->

### When to Choose

| Scenario                                | Recommended |
| --------------------------------------- | ----------- |
| Privacy-sensitive use                   | Local AI    |
| Low-power or older device               | Backend     |
| No internet available                   | Local AI    |
| Multi-mic mixing with server processing | Backend     |
| VAD-gated transcription                 | Local AI    |

### Behavior

- You cannot switch methods while actively capturing or streaming.
- Selecting a method immediately shows or hides the relevant configuration panels.
