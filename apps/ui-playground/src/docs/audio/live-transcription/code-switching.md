## Code-Switching

Enables automatic detection of multiple languages within a single audio stream. When someone switches languages mid-conversation, the model adapts without a manual change.

<!-- @section -->

### How It Works

- When enabled, the language setting is overridden to `auto`
- In Local AI mode, the `codeSwitching` flag is passed to the Whisper model
- In Backend mode, the flag is sent as part of the WebSocket session parameters
- The model detects language boundaries and transcribes each segment in the appropriate language

<!-- @example -->

```tsx
import { useSTT } from '@arcaai/stt';

// Local AI
const stt = useSTT({
  track,
  features: { provider: 'local', codeSwitching: true },
});

// Backend
await realtime.start({ codeSwitching: true });
```

<!-- @/example -->
<!-- @/section -->

### Behavior

- Cannot be toggled while actively capturing audio.
- Overrides the explicit language selection — the model auto-detects instead.
- The transcript panel shows a "Code-switch auto" badge when active.

### When to Use

- Conversations where speakers switch between languages (e.g., English and Hindi).
- Multilingual meetings or interviews with mixed-language phrases.

### When Not to Use

- Single-language audio — setting the language explicitly gives better accuracy.
- When you need deterministic language output.
