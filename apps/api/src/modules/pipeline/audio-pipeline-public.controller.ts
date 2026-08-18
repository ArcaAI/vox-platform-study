/**
 * TASK-760 compatibility re-export — DELETE WITH TASK-761.
 *
 * The controller moved to `audio-pipeline-catalog.controller.ts` and the class
 * is now `AudioPipelineCatalogController` (drift D-E: the old name read as
 * "the `@Public()` one", which it never was). This alias exists for exactly
 * one reason: `src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts`
 * imports the old symbol from this path, and `src/bootstrap/**` is owned by
 * TASK-761 concurrently — TASK-760 must not edit it. TASK-761 should retarget
 * that import at `./audio-pipeline-catalog.controller` and delete this file.
 *
 * @deprecated use `AudioPipelineCatalogController`.
 */
export { AudioPipelineCatalogController as AudioPipelinePublicController } from './audio-pipeline-catalog.controller';
