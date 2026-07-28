import { describe, it, expect } from 'vitest';
import { TenantController } from '../tenant.controller';

const SWAGGER = {
  API_OPERATION: 'swagger/apiOperation',
  API_RESPONSE: 'swagger/apiResponse',
  API_PARAMETERS: 'swagger/apiParameters',
  API_SECURITY: 'swagger/apiSecurity',
  API_TAGS: 'swagger/apiUseTags',
};

function getMethodMetadata(key: string, method: string) {
  return Reflect.getMetadata(key, TenantController.prototype[method]);
}

describe('TenantController - OpenAPI/Swagger metadata', () => {
  describe('class-level decorators', () => {
    it('should have @ApiTags("admin-tenants")', () => {
      const tags = Reflect.getMetadata(SWAGGER.API_TAGS, TenantController);
      expect(tags).toContain('admin-tenants');
    });

    it('should have @ApiBearerAuth()', () => {
      const security = Reflect.getMetadata(SWAGGER.API_SECURITY, TenantController);
      expect(security).toBeDefined();
      expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
    });
  });

  describe('create', () => {
    it('should have @ApiOperation with summary', () => {
      const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'create');
      expect(metadata).toBeDefined();
      expect(metadata.summary).toBeDefined();
    });

    it('should have @ApiResponse for 400 (bad request)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'create');
      expect(responses).toBeDefined();
      expect(responses[400]).toBeDefined();
    });
  });

  describe('fetchAll', () => {
    it('should have @ApiOperation with summary', () => {
      const metadata = getMethodMetadata(SWAGGER.API_OPERATION, 'fetchAll');
      expect(metadata).toBeDefined();
      expect(metadata.summary).toBeDefined();
    });

    it('should have @ApiQuery parameters for pagination', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchAll');
      expect(params).toBeDefined();
      const queryParams = params.filter((p: any) => p.in === 'query');
      const names = queryParams.map((p: any) => p.name);
      expect(names).toEqual(expect.arrayContaining(['page', 'pageSize']));
    });
  });

  describe('fetchByUserId', () => {
    it('should have @ApiParam for userId', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchByUserId');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('userId');
    });
  });

  describe('fetchById', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchById');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchById');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('fetchByCodeName', () => {
    it('should have @ApiParam for code-name', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchByCodeName');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('code-name');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'fetchByCodeName');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('update', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'update');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'update');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should have @ApiParam for id', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'delete');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('id');
    });

    it('should have @ApiResponse for 404 (not found)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'delete');
      expect(responses).toBeDefined();
      expect(responses[404]).toBeDefined();
    });
  });

  describe('fetchTenantConfigs', () => {
    it('should have @ApiParam for identifier', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'fetchTenantConfigs');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('identifier');
    });
  });

  describe('updateTenantConfigs', () => {
    it('should have @ApiParam for identifier', () => {
      const params = getMethodMetadata(SWAGGER.API_PARAMETERS, 'updateTenantConfigs');
      expect(params).toBeDefined();
      const pathParams = params.filter((p: any) => p.in === 'path');
      const names = pathParams.map((p: any) => p.name);
      expect(names).toContain('identifier');
    });

    it('should have @ApiResponse for 400 (bad request)', () => {
      const responses = getMethodMetadata(SWAGGER.API_RESPONSE, 'updateTenantConfigs');
      expect(responses).toBeDefined();
      expect(responses[400]).toBeDefined();
    });
  });
});
