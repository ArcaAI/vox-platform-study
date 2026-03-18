import { AuditLogServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogController } from './audit-log.controller';

/**
 * AuditLogModule - Module for audit log management
 *
 * This module provides REST API endpoints for accessing audit logs.
 * Audit logs are created automatically by the system when resources
 * are created, viewed, updated, or deleted.
 *
 * Imports:
 * - AuditLogServiceModule: Provides IAuditLogService for business logic
 * - AuthModule: Provides authentication guards and decorators
 */
@Module({
    imports: [AuditLogServiceModule, AuthModule],
    controllers: [AuditLogController],
})
export class AuditLogModule {}
