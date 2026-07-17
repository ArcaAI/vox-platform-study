-- TASK-505 P5 — Prisma↔Python AiModelFormat/ModelTaskType enum sync.
-- Purely ADDITIVE (ALTER TYPE ... ADD VALUE); safe to apply via psql on
-- db-push-managed dev databases (see docs/implementation/TASK-505 README).

ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'ONNX_OPTIMUM';
ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'AZURE_SPEECH';
ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'AZURE_FOUNDRY';
ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'PARAKEET_CPP';

ALTER TYPE core."ModelTaskType" ADD VALUE IF NOT EXISTS 'SPEAKER_DIARIZATION';
ALTER TYPE core."ModelTaskType" ADD VALUE IF NOT EXISTS 'SPEAKER_EMBEDDING';
