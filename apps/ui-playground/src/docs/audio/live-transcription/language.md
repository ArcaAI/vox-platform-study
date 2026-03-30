## Language

Sets the transcription language for Local AI mode. Explicitly specifying the language improves recognition accuracy. In Backend mode, the language is determined by the selected pipeline configuration.

<!-- @section -->

### Supported Languages

| Code | Language |
|------|----------|
| `en` | English |
| `hi` | Hindi |
| `ta` | Tamil |
| `ml` | Malayalam |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `th` | Thai |

<!-- @example -->

```tsx
import { useSTT } from '@arcaai/stt';

const stt = useSTT({
  track,
  audio: { language: 'en' },
  features: { provider: 'local', modelId: 'whisper-base' },
});
```

<!-- @/example -->
<!-- @/section -->

### Behavior

- Cannot be changed while actively capturing audio.
- Defaults to English (`en`).
- When **Code-Switching** is enabled, the language is automatically overridden to `auto`.
- In Local AI mode, the language is set directly on the Whisper model.
- In Backend mode, the language is configured in the pipeline.

### Tips

- Always set the language explicitly when you know what's being spoken.
- For mixed-language audio, use **Code-Switching** instead of picking a single language.
