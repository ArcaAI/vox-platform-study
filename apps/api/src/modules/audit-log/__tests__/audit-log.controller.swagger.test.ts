import { describe, it, expect } from 'vitest';
import { AuditLogController } from '../audit-log.controller';

const SWAGGER = {
    API_OPERATION: 'swagger/apiOperation',
    API_RESPONSE: 'swagger/apiResponse',
    API_PARAMETERS: 'swagger/apiParameters',
    API_SECURITY: 'swagger/apiSecurity',
    API_TAGS: 'swagger/apiUseTags',
};

function getMethodMetadata(key: string, method: string) {
    return Reflect.getMetadata(key, AuditLogController.prototype[method]);
}

describe('AuditLogController - OpenAPI/Swagger metadata', () => {
    describe('class-level decorators', () => {
        it('should have @ApiTags("admin-audit-logs")', () => {
            const tags = Reflect.getMetadata(SWAGGER.API_TAGS, AuditLogController);
            expect(tags).toContain('admin-audit-logs');
        });

        it('should have @ApiBearerAuth()', () => {
            const security = Reflect.getMetadata(SWAGGER.API_SECURITY, AuditLogController);
            expect(security).toBeDefined();
            expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
        });
    });

    describe('fetchAll', () => {
        it('should have @ApiOperation with summary', () => {
            const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'fetchAll');
            expect(metadata).toBeDefined();
            expect(metadata.summary).toBeDefined();
        });

        it('should have @ApiResponse for 200', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchAll');
            expect(responses).toBeDefined();
            expect(responses[200]).toBeDefined();
        });

        it('should have @ApiQuery for pagination', () => {
            const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchAll');
            expect(params).toBeDefined();
            const queryParams = params.filter((p: any) => p.in === 'query');
            const names = queryParams.map((p: any) => p.name);
            expect(names).toEqual(expect.arrayContaining(['page', 'pageSize']));
        });
    });

    describe('fetchById', () => {
        it('should have @ApiResponse for 404 (not found)', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchById');
            expect(responses).toBeDefined();
            expect(responses[404]).toBeDefined();
        });
    });

    describe('fetchByResource', () => {
        it('should have @ApiResponse for 200', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchByResource');
            expect(responses).toBeDefined();
            expect(responses[200]).toBeDefined();
        });
    });

    describe('fetchByUser', () => {
        it('should have @ApiResponse for 200', () => {
            const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchByUser');
            expect(responses).toBeDefined();
            expect(responses[200]).toBeDefined();
        });
    });

    // OB-10 (TASK-336): the delete route was removed for audit-log immutability,
    // so there is no `delete` handler (and therefore no Swagger metadata) at all.
    describe('delete (removed — OB-10)', () => {
        it('exposes no delete handler', () => {
            expect(
                (AuditLogController.prototype as unknown as Record<string, unknown>).delete,
            ).toBeUndefined();
        });
    });
});
