-- TASK-507 — new whisper.cpp ASR engine (GGUF whisper-large-v3-turbo).
-- Purely ADDITIVE (ALTER TYPE ... ADD VALUE); safe to apply via psql on
-- db-push-managed dev databases (see docs/implementation/TASK-505 README).

ALTER TYPE core."AiModelFormat" ADD VALUE IF NOT EXISTS 'WHISPER_CPP';
