## Local AI Model

Selects which Whisper model to use for on-device transcription. Different models trade off between speed, accuracy, and download size.

<!-- @section -->

### Available Models

| Model | Size | Speed | Best For |
|-------|------|-------|----------|
| **Whisper Tiny** | ~75 MB | Fastest | Real-time use on lower-power devices |
| **Whisper Base** | ~140 MB | Fast | General-purpose transcription |
| **Whisper Small** | ~460 MB | Moderate | When accuracy matters more than speed |

<!-- @example -->

```tsx
import { useSTT } from '@arcaai/stt';

const { transcriptions, loadProgress } = useSTT({
  track,
  features: {
    provider: 'local',
    modelId: 'whisper-base', // 'tiny' | 'base' | 'small'
  },
  onProgress: (progress) => {
    console.log(`Model loading: ${progress.percent}%`);
  },
});
```

<!-- @/example -->
<!-- @/section -->

### How It Works

1. Select a model from the dropdown
2. On first use, model files are downloaded and cached in browser Cache Storage
3. Subsequent uses load instantly from cache
4. A badge shows whether the model is already cached; a progress bar tracks the download

### Behavior

- Cannot change the model while actively capturing audio.
- All models run quantized for browser performance.
- Clearing browser cache requires re-downloading the model.

### Tips

- Start with **Whisper Tiny** for the fastest experience.
- Use **Whisper Base** for a good balance of speed and quality.
- Choose **Whisper Small** when transcription accuracy is the priority.
- Check the cache badge to know if a model needs downloading before starting
