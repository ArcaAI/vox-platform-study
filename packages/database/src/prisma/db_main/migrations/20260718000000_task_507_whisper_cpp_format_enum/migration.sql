-- New whisper.cpp ASR engine (GGUF whisper-large-v3-turbo).
-- Purely ADDITIVE (ALTER TYPE ... ADD VALUE); safe to apply via psql on
-- db-push-managed dev databases (see docs/implementation/).

ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'WHISPER_CPP';
