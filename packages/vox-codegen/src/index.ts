/**
 * @arcaai/vox-codegen — build-time TypeScript codegen for a tenant's
 * consultation context schema.
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
export { fetchPublishedCatalogue, type FetchPublishedCatalogueOptions } from './fetch-catalogue';
export { generateCatalogueTypes, type CatalogueSurface, type GenerateCatalogueOptions, type GeneratedCatalogueFile } from './generate-catalogue';
export { runCatalogueCodegenOnce, type RunCatalogueCodegenOptions, type RunCatalogueCodegenResult, type WrittenCatalogueFile } from './run-catalogue';
export { watchCodegen, type WatchOptions, type WatchCycleInfo } from './watch';
export {
  CONTEXT_PRIMITIVES,
  UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE,
  type ContextPrimitive,
  type ContextKindDeclaration,
  type ContextOutputDeclaration,
  type ConsultationContextSchemaDefinition,
  type ConsultationSchemaBundle,
  type PublishedAgent,
  type PublishedCatalogue,
  type PublishedWorkflow,
} from './types';
