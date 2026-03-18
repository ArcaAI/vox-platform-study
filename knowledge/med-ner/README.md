# Med NER (`@arcaai/med-ner`)

Medical Named Entity Recognition plugin using Transformers.js. Extracts medical entities from text including diseases, medications, procedures, anatomy, lab values, symptoms, and more — entirely in the browser.

## Overview

`@arcaai/med-ner` runs NER models via Transformers.js and ONNX Runtime WebAssembly, requiring no server-side processing. It supports multiple biomedical NER models from Hugging Face, handles B-I-O tag merging automatically, and chunks long texts for models with limited sequence lengths.

When integrated with [`@arcaai/vox`](../agentic-sdk-v2/README.md), it can auto-extract entities from transcriptions as they arrive, populating the context with structured medical data.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    MedNERProcessor                          │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Input Text ──► Tokenizer ──► ONNX Model ──► Post-Process  │
│                  (chunking)    (inference)    (B-I-O merge) │
│                                                             │
│  Transformers.js                                            │
│  ├── Tokenizer (HuggingFace)                               │
│  ├── ONNX Runtime (WebAssembly)                            │
│  └── Model Cache (IndexedDB)                               │
│                                                             │
│  Output: EntitySpan[]                                       │
│  { text, type, score, start, end }                         │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @arcaai/med-ner
```

This is an optional peer dependency of `@arcaai/vox`. Models are downloaded on first use and cached in IndexedDB.

## API Reference

### MedNERProcessor

| Method | Type | Description |
|--------|------|-------------|
| `init()` | `() => Promise<void>` | Download model and initialize |
| `destroy()` | `() => Promise<void>` | Release resources |
| `isSupported()` | `() => boolean` | Browser support check |
| `isInitialized()` | `() => boolean` | Whether model is loaded |
| `isProcessing()` | `() => boolean` | Whether extraction is running |
| `extract(text)` | `(string) => Promise<MedNERResult>` | Extract entities from text |
| `getModelId()` | `() => string` | Active model ID |
| `getOptions()` | `() => MedNEROptions` | Current options |
| `updateOptions(options)` | `(Partial<MedNEROptions>) => void` | Update options |
| `getStats()` | `() => MedNERStats` | Processing statistics |
| `resetStats()` | `() => void` | Reset statistics |

### createMedNER (Factory)

```typescript
import { createMedNER } from '@arcaai/med-ner';

const ner = createMedNER({
  model: 'biomedical',
  threshold: 0.6,
});

await ner.init();

const result = await ner.extract(
  'Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg twice daily.'
);

console.log(result.entities);
// [
//   { text: 'Type 2 Diabetes', type: 'DISEASE', score: 0.95, start: 24, end: 39 },
//   { text: 'Metformin', type: 'MEDICATION', score: 0.92, start: 55, end: 64 },
//   { text: '500mg', type: 'DOSAGE', score: 0.88, start: 65, end: 70 },
// ]

await ner.destroy();
```

### useMedNER (Hook)

```typescript
import { useMedNER } from '@arcaai/med-ner';

const {
  isReady,
  isProcessing,
  isLoading,
  loadProgress,
  entities,
  result,
  stats,
  error,
  processor,
  init,
  extract,
  extractBatch,
  clear,
  resetStats,
  updateOptions,
  destroy,
} = useMedNER({
  model: 'biomedical',
  threshold: 0.6,
  autoInit: true,
  onEntitiesExtracted: (result) => console.log('Found:', result.entities.length),
});
```

| Property | Type | Description |
|----------|------|-------------|
| `isReady` | `boolean` | Model loaded and ready |
| `isProcessing` | `boolean` | Extraction in progress |
| `isLoading` | `boolean` | Model downloading |
| `loadProgress` | `ModelLoadProgress \| null` | Download progress |
| `entities` | `EntitySpan[]` | Last extracted entities |
| `result` | `MedNERResult \| null` | Full extraction result |
| `stats` | `MedNERStats \| null` | Processing statistics |
| `error` | `Error \| null` | Error state |

## Configuration

### MedNEROptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | `'default'` | Model selection (see table below) |
| `threshold` | `number` | `0.5` | Confidence threshold 0–1 |
| `entityTypes` | `MedicalEntityType[]?` | all | Filter to specific entity types |
| `mergeAdjacent` | `boolean` | `true` | Merge adjacent B-I-O entities |
| `mergeOverlapping` | `boolean` | `true` | Merge overlapping entities (keep highest score) |
| `maxLength` | `number` | `512` | Max token length before chunking |
| `chunkOverlap` | `number` | `50` | Token overlap between chunks |
| `enableStats` | `boolean` | `false` | Track processing statistics |
| `statsInterval` | `number` | `1000` | Stats emission interval (ms) |
| `dtype` | `'fp32' \| 'fp16' \| 'q8' \| 'q4'` | `'q8'` | Model quantization |
| `onProgress` | `(progress) => void` | — | Model loading progress callback |

## Entity Types

```typescript
enum MedicalEntityType {
  DISEASE,      // Diseases and conditions
  MEDICATION,   // Drugs and medications
  PROCEDURE,    // Medical procedures
  ANATOMY,      // Body parts and organs
  LAB_VALUE,    // Lab tests and values
  SYMPTOM,      // Symptoms and signs
  DOSAGE,       // Dosage information
  FREQUENCY,    // e.g., "twice daily"
  DURATION,     // e.g., "for 7 days"
  GENE,         // Genes and proteins
  CHEMICAL,     // Chemical compounds
  OTHER,        // Unclassified medical entities
}
```

## Model Selection

| Model | ID | Description | Source |
|-------|----|-------------|--------|
| Default | `default` | General NER | `Xenova/bert-base-NER` |
| Biomedical | `biomedical` | Biomedical entities | `Kushtrim/bert-base-cased-biomedical-ner` |
| Clinical | `clinical` | Clinical notes | `samrawal/bert-base-uncased_clinical-ner` |
| Custom | `owner/model-name` | Any HuggingFace model with ONNX weights | User-specified |

Use `dtype: 'q8'` (default) or `dtype: 'q4'` for faster loading and lower memory. Models are cached in IndexedDB after first download.

## Utility Functions

| Function | Description |
|----------|-------------|
| `filterEntitiesByThreshold(entities, threshold)` | Filter by confidence |
| `filterEntitiesByType(entities, types)` | Filter by entity type |
| `mergeAdjacentEntities(entities)` | Merge B-I-O tagged entities |
| `mergeOverlappingEntities(entities)` | Merge overlapping spans |
| `sortEntitiesByScore(entities)` | Sort by confidence descending |
| `sortEntitiesByPosition(entities)` | Sort by text position |
| `getTopEntities(entities, n)` | Get top N entities |
| `highlightEntities(text, entities)` | Generate highlighted HTML |
| `deduplicateEntities(entities)` | Remove duplicates |
| `groupEntitiesByType(entities)` | Group into a type map |
| `countEntitiesByType(entities)` | Count per type |
| `getAverageConfidence(entities)` | Average confidence score |

## Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome 80+ | Full | Recommended |
| Firefox 78+ | Full | Good performance |
| Safari 15+ | Full | May be slower |
| Edge 80+ | Full | Chromium-based |
| iOS Safari | Limited | Constrained by memory |

### Requirements

- WebAssembly
- Fetch API
- IndexedDB (for model caching)

```typescript
import { isMedNERSupported, getMedNERBrowserSupport } from '@arcaai/med-ner';

if (!isMedNERSupported()) {
  console.error('NER not supported');
}

const support = getMedNERBrowserSupport();
// { webAssembly, indexedDB, fetch, nerSupported, recommendedDtype }
```

## Integration with @arcaai/vox

When used with the Agentic SDK, Med NER can auto-extract entities from transcriptions:

```tsx
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: { baseUrl: '...', apiKey: '...' },
  plugins: {
    ner: {
      enabled: true,
      autoExtract: true,
      entityTypes: ['DISEASE', 'MEDICATION', 'SYMPTOM'],
      threshold: 0.7,
    },
  },
};

function ConsultationPage() {
  const { context } = useArca();

  return (
    <div>
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

## Usage Example

```tsx
import { useMedNER, MedicalEntityType } from '@arcaai/med-ner';
import { useState } from 'react';

function MedicalTextAnalyzer() {
  const { isReady, isProcessing, entities, extract, error } = useMedNER({
    model: 'biomedical',
    threshold: 0.6,
    autoInit: true,
  });

  const [text, setText] = useState('');

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Enter medical text..."
      />

      <button onClick={() => extract(text)} disabled={!isReady || isProcessing}>
        {isProcessing ? 'Analyzing...' : 'Analyze'}
      </button>

      {error && <div>{error.message}</div>}

      {entities.length > 0 && (
        <ul>
          {entities.map((entity, i) => (
            <li key={i}>
              <strong>{entity.text}</strong> ({entity.type}) — {(entity.score * 100).toFixed(1)}%
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```
