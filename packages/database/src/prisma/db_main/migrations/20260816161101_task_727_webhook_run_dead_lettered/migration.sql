-- TASK-727: webhook delivery adds a terminal state distinct from a single
-- retryable FAILED attempt — written once, by the delivery processor, after
-- BullMQ's `attempts` are exhausted for a given delivery job.

-- AlterEnum
ALTER TYPE "core"."WebhookRunStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED';
