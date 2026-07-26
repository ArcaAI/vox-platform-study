// Settings registry barrel.
export * from './registry.types';
export * from './scope-cascade';
export * from './settings-registry';
export * from './effective-settings.service';
export * from './effective-settings.module';
export * from './registry';
export * from './descriptors/pipeline.descriptors';
export * from './descriptors/tts.descriptors';
export * from './descriptors/entitlements.descriptors';
export * from './descriptors/model-defaults.descriptors';
export * from './descriptors/agentic-context.descriptors';
export * from './descriptors/agentic-eval.descriptors';
export * from './descriptors/agentic-revisit.descriptors';
export * from './descriptors/agentic-fewshot.descriptors';
export * from './descriptors/platform-ops.descriptors';
// `service-runtime.descriptors` is exported from the package root via a
// dedicated path (its `SERVICE_RUNTIME_DEFAULTS` is shared with the
// effective-config service) and is intentionally not re-exported here.
export * from './descriptors/platform-secrets.descriptors';
export * from './descriptors/bootstrap-env.descriptors';
export * from './descriptors/platform-knobs.descriptors';
export * from './descriptors/feature-flags.descriptors';
export * from './settings-registry-write.service';
export * from './tenant-clamp';
export * from './tenant-settings.service';
