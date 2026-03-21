/**
 * @arcaai/pipeline
 *
 * Pipeline infrastructure for sequential and parallel processing with state management.
 *
 * @example
 * ```typescript
 * import {
 *   SequentialPipeline,
 *   ParallelPipeline,
 *   PipelineStage,
 *   PipelineOrchestrator,
 * } from '@arcaai/pipeline';
 *
 * // Create a sequential pipeline
 * const transcription = new SequentialPipeline('transcription');
 * transcription.addStage(noiseFilterStage, { priority: 10 });
 * transcription.addStage(vadStage, { priority: 20 });
 * transcription.addStage(sttStage, { priority: 30 });
 *
 * // Create a parallel pipeline
 * const knowledge = new ParallelPipeline('knowledge');
 * knowledge.addStage(nerStage, { required: true, triggerMode: 'auto' });
 * knowledge.addStage(spellCheckStage, { required: false, triggerMode: 'manual' });
 *
 * // Coordinate with orchestrator
 * const orchestrator = new PipelineOrchestrator();
 * orchestrator.register('transcription', transcription);
 * orchestrator.register('knowledge', knowledge);
 * orchestrator.connect('transcription', 'knowledge', { autoExecute: true });
 *
 * await orchestrator.init();
 * const transcript = await orchestrator.execute('transcription', audioData);
 * ```
 */

// Type exports
export * from './types/index.js';

// Core exports
export * from './core/index.js';
