/**
 * @arcaai/med-ner - Worker module barrel
 *
 * The actual worker entry (`medner.worker.ts`) is built as a separate
 * bundle by tsup and is not re-exported here — workers are loaded by URL,
 * not by import. See the package README for the recommended factory:
 *
 * ```ts
 * createMedNER({
 *   workerFactory: () =>
 *     new Worker(
 *       new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url),
 *       { type: 'module' },
 *     ),
 * });
 * ```
 */

export {
  MedNERWorkerClient,
  type WorkerLike,
  type MedNERWorkerInitPayload,
  type MedNERWorkerExtractPayload,
  type MedNERWorkerInitResult,
  type MedNERWorkerExtractResult,
} from './workerClient.js';
