# Plugin Architecture Analysis

## Overview

This document analyzes the plugin packages (`@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`) to define best practices for SDK v2 plugin integration.

---

## 1. Room Package - Foundation Layer

### 1.1 Core Classes

```
Room (Orchestrator)
├── AudioContextManager (Singleton AudioContext)
├── AudioTrack (Audio abstraction)
└── ProcessorPipeline (Chain processors)

TypedEventEmitter<TEvents> (Base)
├── Room
├── AudioTrack
└── BaseProcessor
```

### 1.2 AudioTrack - Core Abstraction

```typescript
class AudioTrack extends TypedEventEmitter<TrackEventMap> {
  private sourceTrack: MediaStreamTrack | null;
  private currentProcessor: TrackProcessor | null;
  private audioContext: AudioContext | null;
  private readonly processorLock: AsyncLock;
  
  // Returns processed track if processor attached, else source
  get mediaStreamTrack(): MediaStreamTrack | null {
    return this.currentProcessor?.processedTrack ?? this.sourceTrack;
  }
  
  async setProcessor(processor: TrackProcessor | null): Promise<void> {
    await this.processorLock.acquire();
    try {
      // Cleanup old processor
      if (this.currentProcessor) {
        await this.currentProcessor.destroy();
      }
      // Initialize new processor
      if (processor) {
        await processor.init({
          track: this.sourceTrack!,
          audioContext: this.audioContext!,
        });
      }
      this.currentProcessor = processor;
    } finally {
      this.processorLock.release();
    }
  }
}
```

### 1.3 ProcessorPipeline - Chaining

```typescript
class ProcessorPipeline implements TrackProcessor {
  private processors: ProcessorConfig[] = [];
  
  async addProcessor(processor: TrackProcessor, options?: { priority?: number }): Promise<void> {
    this.processors.push({ processor, priority: options?.priority ?? 50 });
    this.processors.sort((a, b) => a.priority - b.priority);
    await this.rebuild();
  }
  
  async setProcessorEnabled(name: string, enabled: boolean): Promise<void> {
    const config = this.processors.find(p => p.processor.name === name);
    if (config) {
      config.enabled = enabled;
      await this.rebuild();
    }
  }
}
```

### 1.4 TrackProcessor Interface

```typescript
interface TrackProcessor<TOptions extends ProcessorOptions = AudioProcessorOptions> {
  readonly name: string;
  processedTrack?: MediaStreamTrack;
  
  init(opts: TOptions): Promise<void>;
  restart(opts: TOptions): Promise<void>;
  destroy(): Promise<void>;
  
  onAttach?(): Promise<void>;
  onDetach?(): Promise<void>;
  enable?(): Promise<void>;
  disable?(): Promise<void>;
  isEnabled?(): boolean;
  isSupported?(): boolean;
}
```

---

## 2. BaseProcessor - Template Pattern

### 2.1 Implementation

```typescript
abstract class BaseProcessor extends TypedEventEmitter<ProcessorEventMap> {
  readonly name: string;
  processedTrack?: MediaStreamTrack;
  
  protected status: ProcessorStatus = ProcessorStatus.IDLE;
  protected audioContext: AudioContext | null = null;
  protected sourceTrack: MediaStreamTrack | null = null;
  protected _enabled = true;
  
  // Template method
  async init(opts: AudioProcessorOptions): Promise<void> {
    this.status = ProcessorStatus.INITIALIZING;
    this.audioContext = opts.audioContext;
    this.sourceTrack = opts.track;
    
    await this.onInit(opts);  // Subclass implementation
    
    this.status = ProcessorStatus.READY;
    this.emit(ProcessorEvent.Ready, {});
  }
  
  async destroy(): Promise<void> {
    await this.onDestroy();  // Subclass cleanup
    this.status = ProcessorStatus.DESTROYED;
    this.emit(ProcessorEvent.Destroyed, {});
  }
  
  // Abstract methods for subclasses
  protected abstract onInit(opts: AudioProcessorOptions): Promise<void>;
  protected abstract onDestroy(): Promise<void>;
  
  // Helper for emitting typed data
  protected emitData<T>(type: string, data: T): void {
    this.emit(ProcessorEvent.Data, { type, data, timestamp: Date.now() });
  }
}
```

### 2.2 ProcessorStatus States

```typescript
enum ProcessorStatus {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  ERROR = 'error',
  DESTROYED = 'destroyed',
}
```

---

## 3. STT Package Architecture

### 3.1 Provider Strategy Pattern

```typescript
type STTProviderType = 'local' | 'backend' | 'auto';

interface STTProvider {
  readonly name: string;
  readonly type: 'local' | 'backend';
  
  isSupported(): boolean;
  init(config: ProviderConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  processAudio(audio: Float32Array, sampleRate: number): Promise<void>;
  transcribeSegment(audio: Float32Array): Promise<TranscriptionResult>;
  destroy(): Promise<void>;
  isReady(): boolean;
  isProcessing(): boolean;
  onTranscription(callback: TranscriptionCallback): void;
  onError(callback: ErrorCallback): void;
  getStats(): STTStats;
}
```

### 3.2 LocalSTTProvider

```typescript
class LocalSTTProvider extends BaseSTTProvider {
  readonly name = 'local-whisper';
  readonly type = 'local' as const;
  
  private engine: WhisperEngine | null = null;
  private bufferManager: AudioBufferManager | null = null;
  
  async init(config: ProviderConfig): Promise<void> {
    this.engine = new WhisperEngine();
    await this.engine.init({
      modelSize: config.model || 'tiny',
      device: config.device || 'auto',
      onProgress: config.onProgress,
    });
    
    this.bufferManager = new AudioBufferManager({
      chunkLengthS: 30,
      strideLengthS: 5,
    });
  }
  
  async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
    this.bufferManager.append(audio, sampleRate);
    
    while (this.bufferManager.hasChunk()) {
      const chunk = this.bufferManager.getChunk();
      const result = await this.engine.transcribe(chunk);
      this.emitTranscription(result);
    }
  }
}
```

### 3.3 BackendSTTProvider

```typescript
class BackendSTTProvider extends BaseSTTProvider {
  readonly name = 'backend-websocket';
  readonly type = 'backend' as const;
  
  private wsClient: WebSocketClient | null = null;
  private audioQueue: Float32Array[] = [];
  
  async init(config: ProviderConfig): Promise<void> {
    this.wsClient = new WebSocketClient({
      url: config.wsUrl!,
      sessionId: config.sessionId!,
      onTranscription: (result) => this.emitTranscription(result),
    });
    
    await this.wsClient.connect();
  }
  
  async processAudio(audio: Float32Array): Promise<void> {
    this.wsClient.sendAudio(audio);
  }
}
```

### 3.4 Auto Provider Selection

```typescript
function getRecommendedProvider(): STTProviderType {
  if (isTransformersJsSupported()) return 'local';
  if (isWebSocketSupported()) return 'backend';
  return 'local';  // Fallback
}

class STTProcessor extends BaseProcessor {
  private resolveProviderType(): Exclude<STTProviderType, 'auto'> {
    if (this.options.provider === 'auto') {
      return getRecommendedProvider();
    }
    return this.options.provider;
  }
}
```

---

## 4. VAD Package Architecture

### 4.1 VADProcessor

```typescript
class VADProcessor extends BaseProcessor {
  private micVAD: MicVAD | null = null;
  
  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const stream = new MediaStream([opts.track]);
    
    // Create passthrough audio path
    this.sourceNode = opts.audioContext.createMediaStreamSource(stream);
    this.destinationNode = opts.audioContext.createMediaStreamDestination();
    this.sourceNode.connect(this.destinationNode);
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
    
    // Initialize MicVAD (separate processing)
    this.micVAD = await MicVAD.new({
      stream,
      onSpeechStart: () => this.emitData('vad-speech-start', { timestamp: Date.now() }),
      onSpeechEnd: (audio) => this.emitData('vad-speech-end', { audio, duration: audio.length / 16000 }),
      onVADMisfire: () => this.emitData('vad-misfire', {}),
    });
  }
}
```

### 4.2 VAD Event Types

```typescript
type VADDataEventType =
  | 'vad-frame'           // Per-frame: { probability: number }
  | 'vad-speech-start'    // Speech started
  | 'vad-speech-real-start' // Confirmed speech (>minDuration)
  | 'vad-speech-end'      // { audio: Float32Array, duration: number }
  | 'vad-misfire'         // Speech too short
  | 'vad-stats';          // { framesProcessed, speechSegments, etc. }
```

### 4.3 useVAD Hook

```typescript
function useVAD(options: UseVADOptions): UseVADReturn {
  const { track, autoAttach = true, onSpeechEnd } = options;
  const processorRef = useRef<VADProcessor | null>(null);
  
  useEffect(() => {
    processorRef.current = new VADProcessor(options);
    
    processorRef.current.on(ProcessorEvent.Data, (payload) => {
      if (payload.type === 'vad-speech-end') {
        onSpeechEnd?.(payload.data);
      }
    });
    
    return () => processorRef.current?.destroy();
  }, []);
  
  // Auto-attach when track available
  useEffect(() => {
    if (autoAttach && track && !isAttached) {
      track.setProcessor(processorRef.current);
    }
  }, [track, autoAttach]);
  
  return { isSpeaking, speechProbability, attach, detach };
}
```

---

## 5. Noise-Filter Package Architecture

### 5.1 NoiseFilterProcessor

```typescript
class NoiseFilterProcessor extends BaseProcessor {
  private workletNode: AudioWorkletNode | null = null;
  private rnnoiseProcessor: RNNoiseProcessor | null = null;
  
  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;
    
    // Register worklet
    await registerRNNoiseWorklet(audioContext);
    
    // Create audio graph
    const stream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(stream);
    this.destinationNode = audioContext.createMediaStreamDestination();
    
    // Create worklet node
    this.workletNode = new AudioWorkletNode(audioContext, 'rnnoise-processor');
    
    // Send WASM binary to worklet
    const wasmBinary = await fetch(this.options.wasmPath).then(r => r.arrayBuffer());
    this.workletNode.port.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
    
    // Connect: source → worklet → destination
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.destinationNode);
    
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }
}
```

### 5.2 AudioWorklet Pattern

```typescript
// rnnoise.worklet.ts
class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  private wasmInstance: WebAssembly.Instance | null = null;
  private inputBuffer: Float32Array;
  private outputBuffer: Float32Array;
  
  constructor() {
    super();
    this.inputBuffer = new Float32Array(480);  // RNNoise frame size
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  handleMessage(event: MessageEvent) {
    if (event.data.type === 'init') {
      WebAssembly.instantiate(event.data.wasmBinary).then(instance => {
        this.wasmInstance = instance;
        this.port.postMessage({ type: 'ready' });
      });
    }
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0][0];
    const output = outputs[0][0];
    
    // Accumulate to frame size, process, dispense
    // ... RNNoise processing logic
    
    return true;
  }
}
```

### 5.3 Fallback Strategy

```typescript
protected async onInit(opts: AudioProcessorOptions): Promise<void> {
  const support = getNoiseFilterBrowserSupport();
  
  if (support.rnnoiseSupported && this.options.noiseCancellation) {
    await this.initWorkletProcessing(opts.audioContext);
  } else if (support.nativeFallbackAvailable) {
    await this.initNativeFallback();
  } else {
    throw new NoiseFilterError(
      NoiseFilterErrorCode.NOT_SUPPORTED,
      support.unsupportedReason
    );
  }
}
```

---

## 6. Integration Patterns for SDK v2

### 6.1 Pipeline Composition

```typescript
// SDK v2 audio setup
function useArcaAudio(options: UseArcaAudioOptions) {
  const { track } = useAudioTrack();
  const { addProcessor } = useProcessors({ track, usePipeline: true });
  
  useEffect(() => {
    if (!track) return;
    
    // Build processing pipeline with priorities
    const noiseFilter = createNoiseFilter({ level: 'high' });
    const vad = createVAD({ minSpeechMs: 250 });
    const stt = createSTT({ provider: 'auto', model: 'tiny' });
    
    // Lower priority = earlier in chain
    addProcessor(noiseFilter, { priority: 10 });  // First: denoise
    addProcessor(vad, { priority: 20 });          // Second: detect speech
    addProcessor(stt, { priority: 30 });          // Third: transcribe
    
    return () => {
      removeProcessor(noiseFilter);
      removeProcessor(vad);
      removeProcessor(stt);
    };
  }, [track]);
}
```

### 6.2 Event Aggregation

```typescript
// Aggregate events from all processors
function useProcessorEvents(processors: TrackProcessor[]) {
  useEffect(() => {
    const handlers = processors.map(processor => {
      const handler = (payload: ProcessorDataPayload) => {
        // Route to appropriate callback based on type
        switch (payload.type) {
          case 'stt-transcription':
            onTranscription?.(payload.data);
            break;
          case 'vad-speech-end':
            onSpeechEnd?.(payload.data);
            break;
          case 'noise-stats':
            onNoiseStats?.(payload.data);
            break;
        }
      };
      processor.on(ProcessorEvent.Data, handler);
      return { processor, handler };
    });
    
    return () => {
      handlers.forEach(({ processor, handler }) => {
        processor.off(ProcessorEvent.Data, handler);
      });
    };
  }, [processors]);
}
```

### 6.3 Configuration Propagation

```typescript
interface AudioPipelineConfig {
  language: string;
  noiseReduction: boolean;
  noiseLevel: 'low' | 'medium' | 'high';
  vadEnabled: boolean;
  sttProvider: 'local' | 'backend' | 'auto';
  sttModel: 'tiny' | 'base' | 'small';
}

function createAudioPipeline(config: AudioPipelineConfig) {
  const processors: ProcessorConfig[] = [];
  
  if (config.noiseReduction) {
    processors.push({
      processor: createNoiseFilter({ level: config.noiseLevel }),
      priority: 10,
    });
  }
  
  if (config.vadEnabled) {
    processors.push({
      processor: createVAD(),
      priority: 20,
    });
  }
  
  processors.push({
    processor: createSTT({
      provider: config.sttProvider,
      model: config.sttModel,
      language: config.language,
    }),
    priority: 30,
  });
  
  return processors;
}
```

---

## 7. Best Practices Summary

### 7.1 Plugin Implementation

| Practice | Description |
|----------|-------------|
| **Extend BaseProcessor** | Inherit lifecycle management |
| **Use factory functions** | `createSTT()`, `createVAD()`, `createNoiseFilter()` |
| **Emit typed data events** | Use `emitData(type, data)` |
| **Implement isSupported()** | Check browser capabilities |
| **Handle cleanup** | Release all resources in `onDestroy()` |

### 7.2 AudioWorklet Integration

| Practice | Description |
|----------|-------------|
| **Blob URL for bundling** | Inline worklet code |
| **Track registered contexts** | WeakSet to avoid memory leaks |
| **Typed message protocols** | Strong types for port messages |
| **Handle initialization timeout** | 10s default |
| **Transfer ArrayBuffers** | Use Transferable for efficiency |

### 7.3 Browser Compatibility

| Practice | Description |
|----------|-------------|
| **Check support first** | `isSupported()` before init |
| **Implement fallback chain** | AudioWorklet → ScriptProcessor → Native |
| **Safari version check** | 17.4+ for full AudioWorklet |
| **Check SharedArrayBuffer** | For advanced features |

### 7.4 State Management

| Practice | Description |
|----------|-------------|
| **ProcessorStatus enum** | Track lifecycle state |
| **AsyncLock** | Serialize processor changes |
| **Event-driven updates** | Use TypedEventEmitter |
| **Ref for processor instance** | Prevent recreation in React |

---

## 8. SDK v2 Plugin Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      AgenticProvider                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                     RoomProvider                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                    Room                              │  │  │
│  │  │  ┌─────────────────────────────────────────────┐    │  │  │
│  │  │  │              AudioTrack                      │    │  │  │
│  │  │  │  ┌───────────────────────────────────────┐  │    │  │  │
│  │  │  │  │         ProcessorPipeline              │  │    │  │  │
│  │  │  │  │                                        │  │    │  │  │
│  │  │  │  │  ┌──────────┐  ┌───────┐  ┌───────┐  │  │    │  │  │
│  │  │  │  │  │NoiseFilter│→│  VAD  │→│  STT  │  │  │    │  │  │
│  │  │  │  │  │  (p:10)  │  │(p:20) │  │(p:30) │  │  │    │  │  │
│  │  │  │  │  └──────────┘  └───────┘  └───────┘  │  │    │  │  │
│  │  │  │  └───────────────────────────────────────┘  │    │  │  │
│  │  │  └─────────────────────────────────────────────┘    │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│           ┌──────────────────┴──────────────────┐               │
│           ▼                                      ▼               │
│    Zustand Store                          ApiClient              │
│    (Local State)                     (Backend Sync)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Event Flow

```
MediaStreamTrack (Microphone)
        │
        ▼
┌───────────────────┐
│  NoiseFilter      │──── emits: noise-stats
│  Processor        │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│    VAD            │──── emits: vad-speech-start, vad-speech-end
│  Processor        │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│    STT            │──── emits: stt-transcription, stt-speech-start
│  Processor        │
└─────────┬─────────┘
          │
          ▼
    processedTrack (denoised audio)
```

---

## 10. Recommended Plugin Structure

```
@arcaai/my-plugin/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── assets/
│   └── README.md           # Asset loading instructions
├── src/
│   ├── index.ts            # Main exports
│   ├── processors/
│   │   ├── index.ts
│   │   └── MyProcessor.ts  # extends BaseProcessor
│   ├── types/
│   │   └── index.ts        # Type definitions
│   ├── hooks/
│   │   ├── index.ts
│   │   └── useMyPlugin.ts  # React hook
│   ├── utils/
│   │   ├── index.ts
│   │   └── browserSupport.ts
│   └── worklets/           # If AudioWorklet needed
│       ├── index.ts
│       ├── my.worklet.ts
│       └── worklet-loader.ts
```
