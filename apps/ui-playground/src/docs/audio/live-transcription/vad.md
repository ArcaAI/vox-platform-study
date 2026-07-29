## Voice Activity Detection

Detects speech segments in real-time using Silero VAD v5 and only sends detected speech to the Whisper model. Silence is ignored — only actual speech is processed.

<!-- @section -->

### Configuration

| Parameter       | Default | Range   | Description                                                                                         |
| --------------- | ------- | ------- | --------------------------------------------------------------------------------------------------- |
| VAD Toggle      | Off     | On/Off  | Enables VAD-gated transcription mode                                                                |
| VAD Sensitivity | 50%     | 10%–95% | Controls the speech detection threshold. Higher values require a stronger speech signal to trigger. |

<!-- @example -->

```tsx
import { useVAD } from '@arcaai/vad';

const { isSpeaking, speechSegments } = useVAD({
  track,
  sensitivity: 0.5, // 0.0 (least) to 1.0 (most sensitive)
  minSpeechDuration: 180,
  autoAttach: true,
  onSpeechStart: () => console.log('Speaking'),
  onSpeechEnd: (audio) => console.log('Segment:', audio.duration),
});
```

<!-- @/example -->
<!-- @/section -->

### Behavior

- Cannot be toggled while actively capturing audio.
- Only available in **Local AI** processing mode.
- When enabled, audio chunk length is reduced from 5 s to 2 s for lower latency.
- Speech probability and segment count are shown in the transcript status bar.

### When to Use

- **Turn on** for conversations with pauses, meetings, or intermittent speech.
- **Turn off** for continuous dictation where every audio chunk should be transcribed.
- Use **higher sensitivity** (70%+) in noisy environments to avoid false triggers.
- Use **lower sensitivity** (30%–50%) in quiet environments for more responsive detection.
