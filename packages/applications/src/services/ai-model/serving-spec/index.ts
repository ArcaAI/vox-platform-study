export * from './build-resolved-serving-spec';
export * from './IModelServingSpecService';
export * from './model-serving-spec.service';
export * from './model-serving-spec.service.module';
// The contract itself lives in `@arcaai/types`; re-exported so the gateway imports it from here.
export type { ResolvedServingEngine, ResolvedServingSpec, ServingKind } from '@arcaai/types';
