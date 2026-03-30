## Speaker Diarization

Identifies and labels different speakers in the transcript. Each segment is tagged with a speaker identifier when multiple people are talking.

<!-- @section -->

### How It Works

- In Local AI mode, the Whisper model is configured with `diarization: true` and `numSpeakers: 2`
- In Backend mode, diarization is configured in the pipeline
- Speaker labels are resolved through a profile system and displayed as badges in the transcript

<!-- @example -->

```tsx
import { useSTT } from '@arcaai/stt';

// Local AI
const stt = useSTT({
  track,
  features: {
    provider: 'local',
    diarization: true,
    numSpeakers: 2,
  },
});

// Backend — diarization is configured in the pipeline
await realtime.start({ pipelineId: 'diarization-pipeline' });
```

<!-- @/example -->
<!-- @/section -->

### Behavior

- Cannot be toggled while actively capturing audio.
- Works in both Local AI and Backend modes.
- Speaker IDs may shift during a session as the model refines its understanding.

### Tips

- Works best with 2–3 distinct speakers.
- Clearer audio and closer mic placement improve accuracy.
- Combine with **Noise Cancellation** for better speaker separation.
