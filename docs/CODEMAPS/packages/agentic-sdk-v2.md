# Agentic SDK V2 Codemap

**Last Updated:** 2026-03-14  
**Package:** `@arcaai/vox` (Agentic SDK V2)  
**Language:** TypeScript + React  
**Entry Point:** [src/index.ts](../../../../packages/agentic-sdk-v2/src/index.ts)

---

## 📋 Purpose

React SDK for integrating medical consultations into client applications. Provides components, hooks, and utilities for real-time consultation sessions with audio/text interactions, session management, and state synchronization.

---

## 🗂️ Directory Structure

```
packages/agentic-sdk-v2/src/
├── index.ts                   # Public exports
│
├── components/                # React components
│   ├── ConsultationProvider/  # Context provider
│   │   ├── ConsultationProvider.tsx
│   │   ├── ConsultationContext.ts
│   │   └── useConsultation.ts # Hook to access context
│   │
│   ├── ConsultationSession/   # Session UI
│   │   ├── ConsultationSession.tsx
│   │   ├── useSession.ts
│   │   └── styles.module.css
│   │
│   ├── MessageList/           # Message display
│   │   ├── MessageList.tsx
│   │   ├── Message.tsx
│   │   └── styles.module.css
│   │
│   ├── AudioInput/            # Audio recording
│   │   ├── AudioInput.tsx
│   │   ├── Waveform.tsx
│   │   └── useAudioRecorder.ts
│   │
│   ├── TextInput/             # Text message input
│   │   ├── TextInput.tsx
│   │   └── styles.module.css
│   │
│   └── Controls/              # Session controls
│       ├── Controls.tsx
│       ├── Timer.tsx
│       └── StatusIndicator.tsx
│
├── hooks/                     # React hooks
│   ├── useConsultation.ts     # Main context hook
│   ├── useSession.ts          # Session management
│   ├── useAudioRecorder.ts    # Audio recording
│   ├── useMessages.ts         # Message state
│   ├── useMicrophone.ts       # Microphone access
│   └── useWebSocket.ts        # WebSocket connection
│
├── services/                  # Business logic services
│   ├── consultation.service.ts # API calls
│   ├── audio.service.ts       # Audio processing
│   ├── websocket.service.ts   # Real-time events
│   ├── state.service.ts       # State management (Zustand)
│   └── cache.service.ts       # Client-side caching
│
├── types/                     # TypeScript types
│   ├── consultation.types.ts
│   ├── message.types.ts
│   ├── audio.types.ts
│   ├── api.types.ts
│   └── index.ts
│
├── utils/                     # Utilities
│   ├── format.ts              # Text formatting
│   ├── audio-utils.ts         # Audio helpers
│   ├── websocket-utils.ts     # WS helpers
│   └── constants.ts           # SDK constants
│
├── context/                   # React context
│   ├── ConsultationContext.ts
│   ├── AudioContext.ts
│   └── index.ts
│
├── integrations/              # Plugin system
│   ├── room.integration.ts    # @arcaai/room integration
│   ├── vad.integration.ts     # @arcaai/vad integration
│   ├── ner.integration.ts     # @arcaai/med-ner integration
│   └── index.ts
│
├── config/                    # Configuration
│   ├── defaults.ts            # Default settings
│   ├── constants.ts           # SDK constants
│   └── logger.ts              # Client-side logging
│
├── examples/                  # Usage examples
│   ├── BasicConsultation.tsx
│   ├── AdvancedSession.tsx
│   └── CustomUI.tsx
│
└── __tests__/                 # Unit tests
    ├── hooks/
    ├── components/
    └── services/
```

---

## 🎯 Core Features

### ConsultationProvider
Wraps application with consultation state/context.

```tsx
<ConsultationProvider apiUrl="https://api.example.com">
  <YourApp />
</ConsultationProvider>
```

### useConsultation Hook
Access consultation session and methods.

```tsx
function MyComponent() {
  const { 
    session, 
    messages, 
    isRecording,
    sendText,
    startRecording,
    stopRecording,
  } = useConsultation();

  return (
    <div>
      {messages.map(msg => (
        <Message key={msg.id} message={msg} />
      ))}
    </div>
  );
}
```

### Audio Recording
Real-time audio capture with WebAudio API.

```tsx
const { isRecording, startRecording, stopRecording } = useAudioRecorder();

<button onClick={isRecording ? stopRecording : startRecording}>
  {isRecording ? 'Stop' : 'Start Recording'}
</button>
```

### Real-Time Messaging
WebSocket connection for live updates.

```tsx
const { messages, sendText, sendAudio } = useConsultation();

// Send text
sendText('What are my symptoms?');

// Send audio
sendAudio(audioBlob);
```

---

## 🔗 Integration Points

### @arcaai/room
Audio processing framework plugin.

```typescript
import { createRoomPlugin } from '@arcaai/room';

const roomPlugin = createRoomPlugin({
  noiseFilter: true,
  echoCancellation: true,
});

// Integrated in AudioInput component
```

### @arcaai/vad
Voice Activity Detection for audio streaming.

```typescript
import { SileroVAD } from '@arcaai/vad';

const vad = new SileroVAD();
// Detects speech regions in audio stream
```

### @arcaai/med-ner
Medical entity extraction from messages.

```typescript
import { extractMedicalEntities } from '@arcaai/med-ner';

const entities = extractMedicalEntities('chest pain');
// Returns: [{ type: 'SYMPTOM', text: 'chest pain' }]
```

---

## 🔐 API Integration

### Authentication
Supports multiple auth methods:

```typescript
// API Key
const sdk = new ConsultationSDK({
  apiKey: 'your-api-key',
});

// JWT Token
const sdk = new ConsultationSDK({
  token: 'eyJhbG...',
  refreshToken: '...',
});
```

### API Configuration
```typescript
const sdk = new ConsultationSDK({
  apiUrl: 'https://api.example.com',
  websocketUrl: 'wss://api.example.com/ws',
  retryPolicy: {
    maxRetries: 3,
    backoffFactor: 2,
  },
});
```

---

## 🎨 UI Components

### Pre-built Components
- `ConsultationProvider` — Context provider
- `ConsultationSession` — Full-featured UI
- `MessageList` — Message display
- `AudioInput` — Recording interface
- `TextInput` — Text message input
- `Controls` — Session controls

### Customization
All components accept styling props:

```tsx
<ConsultationSession
  theme="dark"
  className="custom-class"
  headerTemplate={<CustomHeader />}
  messageTemplate={<CustomMessageTemplate />}
/>
```

---

## 📊 State Management

Uses Zustand for client-side state:

```typescript
// Consultation state
{
  sessionId: string;
  doctorId: string;
  patientId: string;
  messages: Message[];
  isRecording: boolean;
  isConnected: boolean;
  status: 'active' | 'completed' | 'error';
}
```

---

## 🔗 External Dependencies

### React
- `react>=18.0.0` — React library
- `react-dom>=18.0.0` — DOM rendering

### State & Hooks
- `zustand` — State management
- `react-query` — Server state management

### Audio
- `@arcaai/room` — Audio processing
- `@arcaai/vad` — Voice activity detection

### HTTP
- `axios` — API calls
- `socket.io-client` — WebSocket with fallback

### UI (Optional)
- `@mui/material` — Material UI components (optional)
- `tailwindcss` — Styling (optional)

---

## 🧪 Testing

**Unit Tests**:
```bash
pnpm --filter @arcaai/vox test
```

**Storybook** (Component showcase):
```bash
pnpm --filter @arcaai/vox storybook
```

---

## 🎓 Example Usage

```tsx
import React from 'react';
import { ConsultationProvider, useConsultation } from '@arcaai/vox';

// Wrap app
export default function App() {
  return (
    <ConsultationProvider 
      apiUrl="https://api.example.com"
      apiKey="your-api-key"
    >
      <ConsultationPage />
    </ConsultationProvider>
  );
}

// Use in component
function ConsultationPage() {
  const {
    session,
    messages,
    sendText,
    sendAudio,
    isRecording,
    startRecording,
    stopRecording,
  } = useConsultation();

  if (!session) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>Consultation with {session.doctorName}</h1>
      
      {/* Message list */}
      <ul>
        {messages.map(msg => (
          <li key={msg.id}>
            <strong>{msg.senderName}:</strong>
            {msg.content}
          </li>
        ))}
      </ul>

      {/* Text input */}
      <TextInput onSend={sendText} />

      {/* Audio recording */}
      <button onClick={isRecording ? stopRecording : startRecording}>
        {isRecording ? 'Stop Recording' : 'Start Recording'}
      </button>
    </div>
  );
}
```

---

## 🔗 Related Codemaps

- [Room Package](./room.md) — Audio processing framework
- [VAD Package](./vad.md) — Voice Activity Detection
- [Med NER Package](./med-ner.md) — Medical entity extraction
- [API Gateway](../services/api-gateway.md) — Backend API

---

**Status**: ✅ Current | SDK functional and documented
