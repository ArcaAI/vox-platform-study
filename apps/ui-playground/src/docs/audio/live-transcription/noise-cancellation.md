## Noise Cancellation

Enables browser-level noise suppression on the microphone input. Background noise is reduced before audio reaches the transcription model.

<!-- @section -->

### Levels

| Level      | Description                                         |
| ---------- | --------------------------------------------------- |
| **Low**    | Light filtering, preserves more ambient sound       |
| **Medium** | Balanced noise reduction                            |
| **High**   | Aggressive filtering, removes most background noise |

<!-- @example -->

```tsx
import { useAudioTrack } from '@arcaai/room';

const { track } = useAudioTrack({
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  deviceId: selectedMic.deviceId,
});
```

<!-- @/example -->
<!-- @/section -->

### Behavior

- Cannot be toggled while actively capturing audio.
- `echoCancellation` and `autoGainControl` are always enabled alongside noise cancellation.
- In Backend mode, the `noiseSuppression` flag is sent as part of the WebSocket session config.

### When to Use

- **Turn on** in noisy environments (office, café, outdoors).
- **Turn off** when recording in a quiet room or when ambient sound matters.
- **High level** for very noisy environments; **Low level** for minimal processing.
