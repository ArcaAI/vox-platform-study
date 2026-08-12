/**
 * @arcaai/vox-codegen — build-time TypeScript codegen for a tenant's
 * consultation context schema (TASK-668).
 *
 * Programmatic surface, for anything that wants to call this in-process
 * instead of shelling out to the `vox-codegen` bin. See the package README
 * for the CLI, the placement decision, and the `oneOf`-discrimination /
 * fail-loudly rules.
 */

export { CodegenError } from './errors';
export { jsonSchemaSubsetToTs, type SchemaToTsOptions } from './schema-to-ts';
export { generateConsultationSchemaTypes, type GenerateOptions, type GeneratedFile } from './generate';
export { fetchConsultationSchemaBundle, type FetchConsultationSchemaOptions } from './fetch-schema';
export { runCodegenOnce, type RunCodegenOptions, type RunCodegenResult } from './run';
export { watchCodegen, type WatchOptions, type WatchCycleInfo } from './watch';
export {
  CONTEXT_PRIMITIVES,
  UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE,
  type ContextPrimitive,
  type ContextKindDeclaration,
  type ContextOutputDeclaration,
  type ConsultationContextSchemaDefinition,
  type ConsultationSchemaBundle,
} from './types';
