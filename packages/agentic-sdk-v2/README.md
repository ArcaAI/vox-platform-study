# @arcaai/vox

ARCAAI Agentic SDK v2 for medical consultation workflows.

## Features

- **Unified API** - Single `useArca()` hook for all SDK functionality
- **Configuration-Driven** - Enable features via configuration, not code
- **Real-time Audio** - Noise filtering, voice activity detection, speech-to-text
- **Context Management** - Case notes, transcriptions, medical entity extraction
- **AI Summarization** - Medical summary generation with DNA writing style
- **Multi-Doctor Support** - New-visit and re-visit consultation workflows
- **Cross-Tab Sync** - Session sharing across browser tabs
- **WebWorker STT** - ML inference runs off main thread

## Installation

```bash
npm install @arcaai/vox
```

## Quick Start

```tsx
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  debug: true,
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en-US' },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}

function ConsultationPage() {
  const { session, audio, context, summary, isReady } = useArca();

  const handleStart = async () => {
    await session.create({
      patientId: 'patient-123',
      appointmentDate: '2026-01-28',
      doctorId: 'doctor-456',
    });
    await audio.start();
  };

  if (!isReady) return <div>Loading...</div>;

  return (
    <div>
      {!session.consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <>
          <p>Audio Level: {audio.level}%</p>
          <p>Speaking: {audio.isSpeaking ? 'Yes' : 'No'}</p>
          {audio.currentTranscript && <p>{audio.currentTranscript}...</p>}

          <h2>Transcriptions</h2>
          {context.transcriptions.map(t => <p key={t.id}>{t.content}</p>)}
        </>
      )}
    </div>
  );
}
```

## Bundle Optimization

Use selective imports for smaller bundles:

```tsx
// Full SDK (~5.5MB)
import { AgenticProvider, useArca } from '@arcaai/vox';

// Core only (~200KB) - no audio plugins
import { AgenticProvider, useArca } from '@arcaai/vox/core';

// Plugins only (~5.3MB) - for lazy loading
import { useVAD, useSTT } from '@arcaai/vox/plugins';
```

## Documentation

- [Full Documentation](../../docs/agentic-sdk-v2/README.md)
- [API Reference](../../docs/agentic-sdk-v2/api-reference.md)
- [Architecture](../../docs/agentic-sdk-v2/architecture.md)
- [Examples](../../docs/agentic-sdk-v2/examples.md)
- [Migration from v1](../../docs/agentic-sdk-v2/migration-guide.md)

## Debug Mode

Set `debug: true` in the configuration to enable verbose audio pipeline logging. When active, the SDK logs to the browser console with `[ARCAAI:DEBUG]` prefix — including pipeline configuration dumps at startup and structured transcript JSON for every final transcription result.

```tsx
const config = {
  api: { baseUrl: '...', apiKey: '...' },
  debug: true,
};
```

See the [full documentation](../../docs/agentic-sdk-v2/README.md) for details on the transcript JSON format.

## Requirements

- **React 18.3.0+** or **React 19.0.4+** (security patched versions)
- Modern browser with Web Audio API support
- API key from ARCAAI

## Security

### React Version Requirements

This SDK requires React versions that include security patches:

- **React 18**: Use version `18.3.0` or higher
- **React 19**: Use version `19.0.4`, `19.1.5`, or `19.2.4` and higher

These versions address CVE-2025-55182 (React Server Components vulnerability). While this SDK is a **client-side library** and does not use React Server Components, we recommend using patched React versions for your overall application security.

### Client-Side Only

This SDK is designed for client-side usage only. All components include the `"use client"` directive to ensure they are not accidentally used in server-side rendering contexts.

### API Key Security

- Never expose API keys in client-side code for production
- Use environment variables and server-side proxies for API authentication
- Consider implementing token-based authentication for production deployments

### Data Privacy

This SDK processes medical data. Ensure compliance with:
- HIPAA (United States)
- GDPR (European Union)
- Other applicable healthcare data regulations

## Related Packages

- `@arcaai/room` - Audio track and processor pipeline
- `@arcaai/noise-filter` - RNNoise-based noise filtering
- `@arcaai/stt` - Speech-to-text (local Whisper + backend)
- `@arcaai/vad` - Voice activity detection (Silero)
- `@arcaai/med-ner` - Medical named entity recognition (optional)

## License

MIT
