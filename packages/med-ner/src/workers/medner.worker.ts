/**
 * @arcaai/med-ner - Medical NER Web Worker
 *
 * Runs the Transformers.js token-classification pipeline in a dedicated
 * Worker so the UI stays responsive during ~200–2000 ms BERT inferences.
 *
 * Protocol (mirrors `MedNERWorkerClient`):
 *
 *   main → worker
 *     { type: 'init',    id, payload: MedNERWorkerInitPayload }
 *     { type: 'extract', id, payload: MedNERWorkerExtractPayload }
 *     { type: 'destroy', id, payload: null }
 *
 *   worker → main
 *     { type: 'ready',    id, payload: { device } }       // init done
 *     { type: 'progress', id, payload: ModelLoadProgress }// during init
 *     { type: 'result',   id, payload: { entities } }     // extract done
 *     { type: 'error',    id, payload: { message } }
 */

import type { MedNERWorkerExtractPayload, MedNERWorkerInitPayload } from './workerClient.js';
import type { EntitySpan, MedicalEntityType as MET, ModelLoadProgress, RawTokenResult } from '../types/index.js';
import { LABEL_TO_ENTITY_TYPE, MedicalEntityType } from '../types/index.js';
import { chunkByTokens, mergeChunkEntities, type Tokenizer, type TokenChunk } from '../utils/chunking.js';
import { filterEntitiesByThreshold, filterEntitiesByType, mergeAdjacentEntities, mergeOverlappingEntities } from '../utils/entityUtils.js';

interface WorkerRequest {
  type: 'init' | 'extract' | 'destroy';
  id: string;
  payload: MedNERWorkerInitPayload | MedNERWorkerExtractPayload | null;
}

interface AggregatedTokenResult {
  entity_group: string;
  word: string;
  score: number;
  start: number;
  end: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- holds the untyped @huggingface/transformers pipeline instance (see the overload-bypass cast in handleInit below)
let nerPipeline: any = null;
let activeConfig: MedNERWorkerInitPayload | null = null;
let tokenizer: Tokenizer | null = null;

function post(message: unknown): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(message);
}

function mapLabel(label: string): MET {
  return LABEL_TO_ENTITY_TYPE[label] ?? MedicalEntityType.OTHER;
}

function isAggregated(r: RawTokenResult | AggregatedTokenResult): r is AggregatedTokenResult {
  return typeof (r as AggregatedTokenResult).entity_group === 'string';
}

function normalise(result: RawTokenResult | AggregatedTokenResult): EntitySpan {
  if (isAggregated(result)) {
    return {
      text: result.word,
      type: mapLabel(result.entity_group),
      start: result.start,
      end: result.end,
      score: result.score,
      rawLabel: result.entity_group,
    };
  }
  return {
    text: result.word.replace(/^##/, ''),
    type: mapLabel(result.entity),
    start: result.start,
    end: result.end,
    score: result.score,
    rawLabel: result.entity,
    tokenIndex: result.index,
  };
}

function buildTokenizerFromPipeline(pipeline: unknown): Tokenizer | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `tokenizer` isn't part of the pipeline's public type; deliberate duck-typing across library versions
  const tok = (pipeline as any).tokenizer;
  if (!tok) return null;
  return (text: string): ArrayLike<unknown> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `tok`'s shape is duck-typed from the untyped cast above, so its call signature can't be known statically
      const encoded = typeof tok === 'function' ? (tok as any)(text) : tok.encode?.(text);
      if (!encoded) return [];
      const ids = encoded.input_ids ?? encoded;
      const arr = ids.data ?? ids;
      if (typeof arr.length === 'number') return arr as ArrayLike<unknown>;
      return [];
    } catch {
      return [];
    }
  };
}

async function handleInit(id: string, payload: MedNERWorkerInitPayload): Promise<void> {
  try {
    if (nerPipeline && activeConfig && activeConfig.modelId === payload.modelId && activeConfig.revision === payload.revision) {
      activeConfig = payload;
      post({ type: 'ready', id, payload: { device: payload.device } });
      return;
    }

    post({ type: 'progress', id, payload: { status: 'downloading', progress: 0 } satisfies ModelLoadProgress });

    const { pipeline, env } = await import('@huggingface/transformers');

    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const pipelineOptions: Record<string, unknown> = {
      dtype: payload.dtype,
      device: payload.device,
      aggregation_strategy: 'simple',
      progress_callback: (progressData: unknown) => {
        const data = progressData as {
          status?: string;
          file?: string;
          progress?: number;
          loaded?: number;
          total?: number;
        };
        post({
          type: 'progress',
          id,
          payload: {
            status: data.status === 'ready' ? 'ready' : 'downloading',
            file: data.file,
            progress: data.progress,
            loaded: data.loaded,
            total: data.total,
          } satisfies ModelLoadProgress,
        });
      },
    };
    if (payload.revision) {
      pipelineOptions.revision = payload.revision;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers' `pipeline()` factory is overloaded per-task; a dynamic task string here doesn't resolve to one specific overload
    nerPipeline = await (pipeline as any)('token-classification', payload.modelId, pipelineOptions);
    tokenizer = buildTokenizerFromPipeline(nerPipeline);
    activeConfig = payload;

    post({ type: 'ready', id, payload: { device: payload.device } });
  } catch (error) {
    post({
      type: 'error',
      id,
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function handleExtract(id: string, payload: MedNERWorkerExtractPayload): Promise<void> {
  if (!nerPipeline || !activeConfig) {
    post({ type: 'error', id, payload: { message: 'Pipeline not initialised. Send "init" first.' } });
    return;
  }
  try {
    const text = payload.text;
    let entities: EntitySpan[];

    const tokensOverBudget = tokenizer !== null && tokenizer(text).length > activeConfig.maxTokens;
    if (tokensOverBudget) {
      const chunks = chunkByTokens(text, tokenizer as Tokenizer, {
        maxTokens: activeConfig.maxTokens,
        stride: activeConfig.stride,
      });
      const chunkResults: Array<{ chunk: TokenChunk; entities: EntitySpan[] }> = [];
      for (const chunk of chunks) {
        const rawResults = (await nerPipeline(chunk.text)) as Array<RawTokenResult | AggregatedTokenResult>;
        const mapped = rawResults.map(normalise);
        for (const ent of mapped) {
          ent.start += chunk.offset;
          ent.end += chunk.offset;
        }
        chunkResults.push({ chunk, entities: mapped });
      }
      entities = mergeChunkEntities(chunkResults);
    } else {
      const rawResults = (await nerPipeline(text)) as Array<RawTokenResult | AggregatedTokenResult>;
      entities = rawResults.map(normalise);
    }

    // Apply post-processing inside the worker so the main thread receives
    // the final, ready-to-render entity list.
    entities = filterEntitiesByThreshold(entities, payload.threshold);
    if (payload.mergeAdjacent) entities = mergeAdjacentEntities(entities, text);
    if (payload.mergeOverlapping) entities = mergeOverlappingEntities(entities);
    if (payload.entityTypes && payload.entityTypes.length > 0) {
      entities = filterEntitiesByType(entities, payload.entityTypes);
    }
    if (!payload.entityTypes?.includes(MedicalEntityType.OTHER)) {
      entities = entities.filter((e) => e.type !== MedicalEntityType.OTHER);
    }

    post({ type: 'result', id, payload: { entities } });
  } catch (error) {
    post({
      type: 'error',
      id,
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function handleDestroy(id: string): void {
  nerPipeline = null;
  activeConfig = null;
  tokenizer = null;
  post({ type: 'ready', id, payload: { status: 'destroyed' } });
}

(self as unknown as { onmessage: (event: MessageEvent<WorkerRequest>) => void }).onmessage = (event) => {
  const { type, id, payload } = event.data;
  switch (type) {
    case 'init':
      void handleInit(id, payload as MedNERWorkerInitPayload);
      break;
    case 'extract':
      void handleExtract(id, payload as MedNERWorkerExtractPayload);
      break;
    case 'destroy':
      handleDestroy(id);
      break;
    default:
      post({ type: 'error', id, payload: { message: `Unknown message type: ${String(type)}` } });
  }
};

export {};
