# Agentic SDK V2 — Examples

Working integration examples for `@arcaai/vox`.

## Common Patterns

### Full Audio Pipeline

```tsx
import { useArca } from '@arcaai/vox';

function AudioPipeline() {
  const { session, audio, context, isReady } = useArca();

  if (!isReady || !session.consultation) return <div>Loading...</div>;

  return (
    <div>
      <div>
        <button onClick={audio.isCapturing ? audio.stop : audio.start}>
          {audio.isCapturing ? 'Stop Recording' : 'Start Recording'}
        </button>
        <button onClick={audio.isMuted ? audio.unmute : audio.mute}>
          {audio.isMuted ? 'Unmute' : 'Mute'}
        </button>
        <button onClick={() => audio.toggleNoiseFilter()}>
          Toggle Noise Filter
        </button>
      </div>

      <div>
        <div style={{ width: `${audio.level}%`, height: 8, background: 'green' }} />
      </div>

      <div>
        <span>{audio.isCapturing ? 'Recording' : 'Stopped'}</span>
        <span>{audio.isSpeaking ? 'Speaking' : 'Silent'}</span>
      </div>

      <div>
        <p>Noise Filter: {audio.plugins.noiseFilter.isActive ? 'Active' : 'Inactive'}</p>
        <p>VAD: {audio.plugins.vad.isActive ? 'Active' : 'Inactive'}</p>
        <p>STT: {audio.plugins.stt.isActive ? 'Active' : 'Inactive'}</p>
      </div>

      {audio.currentTranscript && (
        <p><em>{audio.currentTranscript}...</em></p>
      )}

      <h2>Transcriptions ({context.transcriptions.length})</h2>
      <ul>
        {context.transcriptions.map((t) => (
          <li key={t.id}>
            <p>{t.content}</p>
            <small>{new Date(t.createdAt).toLocaleTimeString()}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Multi-Doctor Workflow (New Visit + Re-Visit)

```tsx
import { useArca, isNewVisit, isRevisit } from '@arcaai/vox';

function MultiDoctorWorkflow() {
  const { session, audio, context, summary } = useArca();
  const [primaryVisitId, setPrimaryVisitId] = useState<string | null>(null);

  const startPrimaryVisit = async () => {
    const consultation = await session.open({
      patientId: 'patient-456',
      appointmentDate: new Date().toISOString().split('T')[0],
      department: 'General',
    });
    setPrimaryVisitId(consultation.id);
    await audio.start();
  };

  const startSpecialistRevisit = async () => {
    await audio.stop();
    await context.addCaseNote('Referred to cardiology for palpitations.');

    await session.open({
      patientId: 'patient-456',
      appointmentDate: new Date().toISOString().split('T')[0],
      department: 'Cardiology',
    });

    const shared = await context.loadSharedContext();
    await audio.start();
  };

  const completeWorkflow = async () => {
    await audio.stop();
    await summary.generateSummary({ includeNER: true });
  };

  return (
    <div>
      <button onClick={startPrimaryVisit}>Start Primary Visit</button>
      <button onClick={startSpecialistRevisit} disabled={!primaryVisitId}>
        Start Specialist Re-Visit
      </button>
      <button onClick={completeWorkflow}>Complete</button>

      {session.consultation && isRevisit(session.consultation) && (
        <div>
          <h3>Related Consultations</h3>
          {session.relatedConsultations.map((c) => (
            <p key={c.id}>{c.doctorName} — {c.department}</p>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Cross-Tab Session Sharing

```tsx
import { useArca } from '@arcaai/vox';

function CrossTabSession() {
  const { session, audio, context, isAudioSource } = useArca();

  return (
    <div>
      <p>Audio Source Tab: {isAudioSource ? 'Yes' : 'No'}</p>

      {isAudioSource ? (
        <button onClick={audio.isCapturing ? audio.stop : audio.start}>
          {audio.isCapturing ? 'Stop' : 'Start'} Recording
        </button>
      ) : (
        <p>Audio is controlled by another tab.</p>
      )}

      <h2>Transcriptions (synced across tabs)</h2>
      {context.transcriptions.map((t) => (
        <p key={t.id}>{t.content}</p>
      ))}
    </div>
  );
}
```

### Error Handling

```tsx
import {
  useArca,
  isAgenticError,
  isNetworkError,
  isAuthError,
} from '@arcaai/vox';

function ConsultationWithErrorHandling() {
  const { session, audio, isReady, error } = useArca();

  const handleStart = async () => {
    try {
      await session.open({
        patientId: 'patient-123',
        appointmentDate: new Date().toISOString().split('T')[0],
      });
      await audio.start();
    } catch (err) {
      if (isNetworkError(err)) {
        console.error('Network error — check your connection');
      } else if (isAuthError(err)) {
        console.error('Authentication failed — redirecting to login');
      } else if (isAgenticError(err)) {
        switch (err.code) {
          case 'CONSULTATION_EXISTS':
            console.error('A consultation already exists for today');
            break;
          case 'AUDIO_PERMISSION_DENIED':
            console.error('Grant microphone permission to continue');
            break;
          default:
            console.error(`SDK Error [${err.code}]: ${err.message}`);
        }
      }
    }
  };

  if (error) {
    return <div>SDK Error: {error.message}</div>;
  }

  return (
    <div>
      {session.error && <div>Session Error: {session.error.message}</div>}
      {audio.error && <div>Audio Error: {audio.error.message}</div>}
      <button onClick={handleStart} disabled={!isReady}>
        Start Consultation
      </button>
    </div>
  );
}
```

### Pipeline Control

```tsx
import { useArca } from '@arcaai/vox';

function PipelineControl() {
  const { pipelines, context } = useArca();

  const handleExtractEntities = async () => {
    const entities = await pipelines.triggerNER(
      'Patient diagnosed with hypertension and prescribed lisinopril 10mg.'
    );
    console.log('Extracted:', entities);
  };

  return (
    <div>
      <h2>Transcription Pipeline</h2>
      <p>Status: {pipelines.transcription?.status ?? 'IDLE'}</p>
      <p>Progress: {pipelines.transcription?.progress ?? 0}%</p>
      <button onClick={pipelines.pauseTranscription}>Pause</button>
      <button onClick={pipelines.resumeTranscription}>Resume</button>

      <h2>Knowledge Pipeline</h2>
      <p>Status: {pipelines.knowledge?.status ?? 'IDLE'}</p>
      <button onClick={handleExtractEntities}>Extract Entities</button>
      <button onClick={() => pipelines.triggerSummarization()}>
        Summarize
      </button>

      <h2>Entities ({context.entities.length})</h2>
      {context.entities.map((e) => (
        <span key={e.id}>
          {e.entityType}: {e.text} ({(e.confidence * 100).toFixed(0)}%)
        </span>
      ))}
    </div>
  );
}
```

### Debug Mode

Enable verbose audio pipeline logging to troubleshoot configuration and transcription issues:

```tsx
import { AgenticProvider } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: process.env.NEXT_PUBLIC_API_KEY,
  },
  debug: true,
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true, sensitivity: 0.5 },
    stt: {
      enabled: true,
      provider: 'local',
      language: 'en-US',
      modelId: 'base',
    },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}
// Open browser console → filter by [ARCAAI:DEBUG] to see:
// 1. Pipeline configuration dump at startup
// 2. Per-plugin config (noise filter, VAD, STT)
// 3. Structured transcript JSON for each final result
```

For standalone plugin debugging without the full SDK:

```typescript
import { STTProcessor } from '@arcaai/stt';

const stt = new STTProcessor({
  debugMode: true,
  features: {
    provider: 'local',
    modelId: 'base',
    returnTimestamps: 'word',
  },
});
// Console output includes config dump on init + transcript JSON per final result
```

### Custom STT Models

```tsx
const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: process.env.NEXT_PUBLIC_API_KEY,
  },
  models: {
    custom: [
      {
        id: 'whisper-medical',
        name: 'Whisper Medical',
        type: 'stt',
        source: 'custom',
        url: 'https://models.arcaai.com/whisper-medical',
        size: 'medium',
      },
    ],
    selected: { stt: 'whisper-medical' },
  },
  audio: {
    stt: {
      enabled: true,
      provider: 'local',
      modelId: 'whisper-medical',
      language: 'en-US',
    },
  },
};
```

### DNA Writing Style Analysis

```tsx
import { useArca } from '@arcaai/vox';

function WritingStyleSetup() {
  const { summary } = useArca();

  const handleAnalyze = async () => {
    const dnaStyle = await summary.analyzeDNA([
      'Patient presents with acute chest pain radiating to left arm...',
      'Assessment reveals elevated troponin levels and ST changes...',
      'Recommend cardiac catheterization within 24 hours...',
    ]);
    console.log('Style ID:', dnaStyle.id);
    console.log('Tone:', dnaStyle.styleData.tone);
  };

  const handleGenerateWithStyle = async () => {
    await summary.generateSummary({
      dnaStyleId: summary.dnaStyle?.id,
      includeNER: true,
    });
  };

  return (
    <div>
      {summary.dnaStyle && (
        <p>Active style: {summary.dnaStyle.styleData.tone} ({summary.dnaStyle.sampleCount} samples)</p>
      )}
      <button onClick={handleAnalyze}>Analyze Writing Style</button>
      <button onClick={handleGenerateWithStyle} disabled={summary.isGenerating}>
        Generate Styled Summary
      </button>
    </div>
  );
}
```
