## Overview

The Audio & Transcription workspace provides real-time speech-to-text from live microphone input. It supports two processing modes: on-device **Local AI** (Whisper WASM) and **Backend** WebSocket streaming.

---

## Install

:::tabs
```pnpm
pnpm add @arcaai/stt @arcaai/vad @arcaai/room
```
```npm
npm install @arcaai/stt @arcaai/vad @arcaai/room
```
:::

---

## Requirements

- Working microphone or audio input device
- Modern browser with `getUserMedia` support (Chrome, Edge, Firefox, Safari)
- Microphone permissions granted in browser
- Internet connection required for Backend WebSocket mode

---

## Processing Modes

| Mode | Description |
|------|-------------|
| **Local AI** | Whisper runs in-browser via WASM. Audio stays on-device. Supports VAD, noise cancellation, diarization, and code-switching. Models are downloaded once and cached. |
| **Backend** | Audio streams over WebSocket to a backend STT service. Lighter on device resources. Requires an active connection. |

---

## Available Settings

Settings vary by processing mode:

| Setting | Local AI | Backend | Description |
|---------|----------|---------|-------------|
| Microphone Sources | ✓ | ✓ | Select one or more input devices |
| Audio Mixer | ✓ | ✓ | Mix multiple mic inputs with per-channel gain and mute |
| Language | ✓ | Pipeline | Set the transcription language |
| Whisper Model | ✓ | — | Choose model size (Tiny, Base, Small) |
| Noise Cancellation | ✓ | ✓ | Toggle browser-level noise suppression with level control |
| Voice Activity Detection | ✓ | — | Only transcribe detected speech segments |
| Speaker Diarization | ✓ | Pipeline | Identify and label different speakers |
| Code-Switching | ✓ | Pipeline | Detect multiple languages within a single stream |

---

## Quick Start

1. Add a microphone source from the left panel
2. Choose a processing method (Local AI or Backend)
3. Configure settings as needed
4. Click "Start Capture" (Local AI) or "Connect & Stream" (Backend)
5. Speak into your microphone to see live transcription
