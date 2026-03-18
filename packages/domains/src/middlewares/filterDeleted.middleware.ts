/**
 * @deprecated This middleware is deprecated in Prisma 7.
 * Use Client Extensions instead. See CoreDatabaseService for implementation.
 *
 * The soft-delete filtering is now handled via Prisma Client Extensions
 * in the CoreDatabaseService class.
 */

import { ResourceStatusType } from '../enums';

// Note: This file is kept for backwards compatibility but is no longer used.
// Prisma 7 removed the $use middleware API.
// Soft-delete filtering is now implemented via Client Extensions in:
// - @arcaai/database/src/client.ts
// - @arcaai/domains/src/common/databaseServices/core/core.database.service.ts

export { ResourceStatusType };
