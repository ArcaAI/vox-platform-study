# @arcaai/med-ner

Medical Named Entity Recognition (NER) plugin for @arcaai/room using Transformers.js.

Extracts medical entities from text including diseases, medications, procedures, anatomy, lab values, symptoms, and more.

## Features

- **Browser-native NER** - Runs entirely in the browser using Transformers.js and ONNX Runtime
- **Multiple models** - Support for various biomedical NER models from Hugging Face
- **Type-safe** - Full TypeScript support with comprehensive types
- **React hooks** - Easy integration with React applications via `useMedNER` hook
- **Configurable** - Adjustable confidence thresholds, entity type filtering, and more
- **Automatic entity merging** - Handles B-I-O tagging and overlapping entities
- **Long text support** - Automatic chunking for texts longer than model max length

## Installation

```bash
pnpm add @arcaai/med-ner
# or
npm install @arcaai/med-ner
```

## Quick Start

### Using the Processor Directly

```typescript
import { createMedNER, MedicalEntityType } from '@arcaai/med-ner';

// Create processor
const ner = createMedNER({
  model: 'biomedical',
  threshold: 0.6,
});

// Initialize (downloads model on first use)
await ner.init();

// Extract entities
const result = await ner.extract(
  'Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg twice daily.'
);

console.log(result.entities);
// [
//   { text: 'Type 2 Diabetes', type: 'DISEASE', score: 0.95, start: 24, end: 39 },
//   { text: 'Metformin', type: 'MEDICATION', score: 0.92, start: 55, end: 64 },
//   { text: '500mg', type: 'DOSAGE', score: 0.88, start: 65, end: 70 },
// ]

// Cleanup when done
await ner.destroy();
```

### Using the React Hook

```tsx
import { useMedNER } from '@arcaai/med-ner';

function MedicalTextAnalyzer() {
  const {
    isReady,
    isProcessing,
    entities,
    extract,
    error,
  } = useMedNER({
    model: 'biomedical',
    threshold: 0.6,
    autoInit: true,
    onEntitiesExtracted: (result) => {
      console.log('Found', result.entities.length, 'entities');
    },
  });

  const [text, setText] = useState('');

  const handleAnalyze = async () => {
    if (text.trim()) {
      await extract(text);
    }
  };

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Enter medical text..."
      />

      <button onClick={handleAnalyze} disabled={!isReady || isProcessing}>
        {isProcessing ? 'Analyzing...' : 'Analyze'}
      </button>

      {error && <div className="error">{error.message}</div>}

      {entities.length > 0 && (
        <ul>
          {entities.map((entity, i) => (
            <li key={i}>
              <strong>{entity.text}</strong> ({entity.type}) - {(entity.score * 100).toFixed(1)}%
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

## Configuration

### Processor Options

```typescript
const ner = createMedNER({
  // Model selection
  model: 'biomedical',  // 'default' | 'biomedical' | 'clinical' | HuggingFace model ID

  // Confidence threshold (0-1)
  threshold: 0.5,

  // Filter to specific entity types
  entityTypes: [MedicalEntityType.DISEASE, MedicalEntityType.MEDICATION],

  // Merge adjacent entities of same type (B-I-O handling)
  mergeAdjacent: true,

  // Merge overlapping entities (keep highest score)
  mergeOverlapping: true,

  // Max text length before chunking
  maxLength: 512,

  // Chunk overlap for long texts
  chunkOverlap: 50,

  // Enable statistics tracking
  enableStats: false,

  // Stats emission interval (ms)
  statsInterval: 1000,

  // Model quantization (affects size/speed/accuracy)
  dtype: 'q8',  // 'fp32' | 'fp16' | 'q8' | 'q4'

  // Progress callback for model loading
  onProgress: (progress) => {
    console.log(`Loading: ${progress.progress}%`);
  },
});
```

### Available Models

| Model | ID | Description |
|-------|----|-----------|
| Default | `default` | General NER (Xenova/bert-base-NER) |
| Biomedical | `biomedical` | Biomedical entities (Kushtrim/bert-base-cased-biomedical-ner) |
| Clinical | `clinical` | Clinical notes (samrawal/bert-base-uncased_clinical-ner) |
| Custom | `owner/model-name` | Any HuggingFace model with ONNX weights |

## Medical Entity Types

```typescript
enum MedicalEntityType {
  DISEASE,      // Diseases and conditions
  MEDICATION,   // Drugs and medications
  PROCEDURE,    // Medical procedures
  ANATOMY,      // Body parts and organs
  LAB_VALUE,    // Lab tests and values
  SYMPTOM,      // Symptoms and signs
  DOSAGE,       // Dosage information
  FREQUENCY,    // Frequency (e.g., "twice daily")
  DURATION,     // Duration (e.g., "for 7 days")
  GENE,         // Genes and proteins
  CHEMICAL,     // Chemical compounds
  OTHER,        // Other medical entities
}
```

## API Reference

### MedNERProcessor

```typescript
class MedNERProcessor {
  // Properties
  readonly name: string;

  // Initialization
  async init(): Promise<void>;
  async destroy(): Promise<void>;

  // State
  isSupported(): boolean;
  isInitialized(): boolean;
  isProcessing(): boolean;

  // Extraction
  async extract(text: string): Promise<MedNERResult>;

  // Configuration
  getModelId(): string;
  getOptions(): MedNEROptions;
  updateOptions(options: Partial<MedNEROptions>): void;

  // Statistics
  getStats(): MedNERStats;
  resetStats(): void;

  // Events
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
}
```

### useMedNER Hook

```typescript
function useMedNER(options: UseMedNEROptions): {
  // State
  isReady: boolean;
  isProcessing: boolean;
  isLoading: boolean;
  loadProgress: ModelLoadProgress | null;
  entities: EntitySpan[];
  result: MedNERResult | null;
  stats: MedNERStats | null;
  error: Error | null;
  processor: MedNERProcessor | null;

  // Methods
  init: () => Promise<void>;
  extract: (text: string) => Promise<MedNERResult>;
  extractBatch: (texts: string[]) => Promise<MedNERResult[]>;
  clear: () => void;
  resetStats: () => void;
  updateOptions: (options: Partial<MedNEROptions>) => void;
  destroy: () => Promise<void>;
};
```

## Utility Functions

### Entity Processing

```typescript
import {
  filterEntitiesByThreshold,
  filterEntitiesByType,
  mergeAdjacentEntities,
  mergeOverlappingEntities,
  sortEntitiesByScore,
  sortEntitiesByPosition,
  getTopEntities,
  highlightEntities,
  deduplicateEntities,
  groupEntitiesByType,
  countEntitiesByType,
  getAverageConfidence,
} from '@arcaai/med-ner';

// Filter by confidence
const highConfidence = filterEntitiesByThreshold(entities, 0.8);

// Filter by type
const diseases = filterEntitiesByType(entities, [MedicalEntityType.DISEASE]);

// Get top 5 entities
const top5 = getTopEntities(entities, 5);

// Highlight in HTML
const html = highlightEntities(text, entities);

// Count by type
const counts = countEntitiesByType(entities);
console.log(`Diseases: ${counts[MedicalEntityType.DISEASE]}`);
```

### Browser Support Detection

```typescript
import {
  isMedNERSupported,
  getMedNERBrowserSupport,
  logBrowserSupport,
} from '@arcaai/med-ner';

// Quick check
if (!isMedNERSupported()) {
  console.error('NER not supported in this browser');
}

// Detailed support info
const support = getMedNERBrowserSupport();
console.log(support);
// {
//   webAssembly: true,
//   indexedDB: true,
//   fetch: true,
//   nerSupported: true,
//   recommendedDtype: 'q8'
// }

// Log to console with formatting
logBrowserSupport();
```

## Integration with @arcaai/vox

```typescript
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  plugins: {
    ner: {
      enabled: true,
      autoExtract: true,  // Auto-extract from transcriptions
      entityTypes: ['DISEASE', 'MEDICATION', 'SYMPTOM'],
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

function ConsultationPage() {
  const { context } = useArca();

  // Extract entities from context
  const entities = await context.extractEntities();
}
```

## Examples

See the `examples/` directory for complete examples:

- `basic-usage.tsx` - Simple extraction example
- `with-react-hook.tsx` - Using useMedNER hook
- `custom-model.tsx` - Loading a custom model
- `batch-processing.tsx` - Processing multiple texts
- `highlighted-text.tsx` - Displaying highlighted entities

## Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome 80+ | ✅ | Recommended |
| Firefox 78+ | ✅ | Good performance |
| Safari 15+ | ✅ | May be slower |
| Edge 80+ | ✅ | Chromium-based |
| iOS Safari | ⚠️ | Limited by memory |

### Requirements

- WebAssembly support
- Fetch API
- IndexedDB (for model caching)

## Performance Tips

1. **Use quantized models** - Set `dtype: 'q8'` or `dtype: 'q4'` for faster loading and lower memory usage
2. **Cache models** - Models are cached in IndexedDB after first download
3. **Chunk long texts** - The processor automatically chunks long texts, but you can adjust `maxLength` and `chunkOverlap`
4. **Filter entity types** - If you only need specific types, use `entityTypes` option to skip post-processing

## License

MIT
