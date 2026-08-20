/*
  TASK-721 R4 (RESOLVED, owner ruling 2026-08-20): WorkflowTestFixture.input
  is now encrypted with Vault Transit, mirroring GoldenCase's
  transcript/referenceNote treatment (harness.prisma) exactly — ciphertext in
  `encryptedInput` + shared `keyVersion`, decrypted on read by the same
  `hope-phi` Transit key and the same phi-read-decrypt.ts wiring.

  Existing rows: this repo is pre-production (no customer/prod data behind
  this brand-new, still design-gated Workbench feature — TASK-721 Task 1 is
  still HUMAN-GATED and unshipped). The plaintext `input` column cannot be
  transformed into Vault-Transit ciphertext with plain SQL (Transit
  encryption requires a live Vault round-trip, which a migration cannot
  perform), so there is no in-place backfill step here. Any local/dev/test
  rows written before this migration are, by this model's own contract,
  synthetic-only non-PHI smoke-test fixtures (see workflow-test-fixture.prisma
  and packages/database/scripts/workbench-fixture-examples.ts) — recreating
  them after this migration is a trivial re-POST through the existing CRUD
  API, so DROP is the correct, low-risk choice over a multi-phase soak.

  Warnings:

  - You are about to drop the column `input` on the `WorkflowTestFixture` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "core"."WorkflowTestFixture" DROP COLUMN "input",
ADD COLUMN     "encryptedInput" BYTEA,
ADD COLUMN     "keyVersion" INTEGER;
