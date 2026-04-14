-- Enable pgvector + pgvectorscale extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;

-- CreateTable
CREATE TABLE "core"."UserVoiceProfile" (
    "_metadata"                JSONB,
    "_version"                 INTEGER NOT NULL DEFAULT 1,
    "id"                       TEXT NOT NULL,
    "userId"                   TEXT NOT NULL,
    "embedding"                vector(256) NOT NULL,
    "qualityScore"             DOUBLE PRECISION NOT NULL,
    "isActive"                 BOOLEAN NOT NULL DEFAULT false,
    "label"                    VARCHAR(100),
    "modelId"                  TEXT,
    "resourceStatus"           "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt"  TIMESTAMP(3),
    "resourceStatusUpdatedBy"  TEXT,
    "createdBy"                TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy"                TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserVoiceProfile_pkey" PRIMARY KEY ("id")
);

-- Composite index for active profile lookup
CREATE INDEX "UserVoiceProfile_userId_isActive_idx"
    ON "core"."UserVoiceProfile"("userId", "isActive");

-- Status filter index
CREATE INDEX "UserVoiceProfile_status_idx"
    ON "core"."UserVoiceProfile"("resourceStatus");

-- FK to User
ALTER TABLE "core"."UserVoiceProfile"
    ADD CONSTRAINT "UserVoiceProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "core"."User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: only 1 active per user
CREATE UNIQUE INDEX "UserVoiceProfile_userId_active_unique"
    ON "core"."UserVoiceProfile"("userId")
    WHERE "isActive" = true AND "resourceStatus" = 'ENABLED';
