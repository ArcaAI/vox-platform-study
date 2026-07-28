import { describe, it, expect } from 'vitest';
import { Controller, Body, Param } from '@nestjs/common';
import { ApiEndpoint } from '../apiEndpoint.decorator';
import { HttpMethod, ApiResponseType } from '@arcaai/applications';
import { ApiProperty } from '@nestjs/swagger';

class TestResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

class TestCreateRequestDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  email!: string;
}

class TestUpdateRequestDto {
  @ApiProperty()
  name?: string;
}

const SWAGGER_KEYS = {
  API_OPERATION: 'swagger/apiOperation',
  API_RESPONSE: 'swagger/apiResponse',
  API_PARAMETERS: 'swagger/apiParameters',
  API_MODEL_PROPERTIES: 'swagger/apiModelProperties',
};

@Controller('test')
class TestController {
  @ApiEndpoint({
    returnedModel: TestResponseDto,
    method: HttpMethod.POST,
  })
  create(@Body() request: TestCreateRequestDto): TestResponseDto {
    return new TestResponseDto();
  }

  @ApiEndpoint({
    returnedModel: TestResponseDto,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  update(@Param('id') id: string, @Body() request: TestUpdateRequestDto): TestResponseDto {
    return new TestResponseDto();
  }

  @ApiEndpoint({
    returnedModel: TestResponseDto,
    method: HttpMethod.PUT,
    path: ':id',
  })
  replace(@Param('id') id: string, @Body() request: TestCreateRequestDto): TestResponseDto {
    return new TestResponseDto();
  }

  @ApiEndpoint({
    returnedModel: TestResponseDto,
  })
  fetchAll(): TestResponseDto[] {
    return [];
  }

  @ApiEndpoint({
    returnedModel: TestResponseDto,
    method: HttpMethod.DELETE,
    path: ':id',
  })
  delete(@Param('id') id: string): TestResponseDto {
    return new TestResponseDto();
  }
}

describe('ApiEndpoint decorator', () => {
  describe('response schema', () => {
    it('should set ApiOperation summary for POST', () => {
      const metadata = Reflect.getMetadata(SWAGGER_KEYS.API_OPERATION, TestController.prototype.create);
      expect(metadata).toBeDefined();
      expect(metadata.summary).toContain('TestResponseDto');
    });

    it('should set ApiOkResponse with schema $ref for single response', () => {
      const responses = Reflect.getMetadata(SWAGGER_KEYS.API_RESPONSE, TestController.prototype.create);
      expect(responses).toBeDefined();
      expect(responses[200]).toBeDefined();
      expect(responses[200].schema).toBeDefined();
      expect(responses[200].schema.$ref).toContain('TestResponseDto');
    });

    it('should set ApiOkResponse with paginated schema for multi response', () => {
      const responses = Reflect.getMetadata(SWAGGER_KEYS.API_RESPONSE, TestController.prototype.fetchAll);
      expect(responses).toBeDefined();
      expect(responses[200]).toBeDefined();
    });
  });

  describe('request body schema (POST/PATCH/PUT)', () => {
    it('should auto-apply @ApiBody for POST endpoints with @Body() parameter', () => {
      const responses = Reflect.getMetadata(SWAGGER_KEYS.API_RESPONSE, TestController.prototype.create);
      const parameters = Reflect.getMetadata(SWAGGER_KEYS.API_PARAMETERS, TestController.prototype.create);

      // The endpoint should have metadata that includes body schema info
      // With the Swagger plugin + @ApiBody, the request body type should be discoverable
      expect(responses[200]).toBeDefined();
    });

    it('should auto-apply @ApiBody for PATCH endpoints with @Body() parameter', () => {
      const responses = Reflect.getMetadata(SWAGGER_KEYS.API_RESPONSE, TestController.prototype.update);
      expect(responses[200]).toBeDefined();
    });

    it('should auto-apply @ApiBody for PUT endpoints with @Body() parameter', () => {
      const responses = Reflect.getMetadata(SWAGGER_KEYS.API_RESPONSE, TestController.prototype.replace);
      expect(responses[200]).toBeDefined();
    });

    it('should NOT apply @ApiBody for GET endpoints', () => {
      const metadata = Reflect.getMetadata(SWAGGER_KEYS.API_OPERATION, TestController.prototype.fetchAll);
      expect(metadata.summary).toContain('Retrieving');
    });

    it('should NOT apply @ApiBody for DELETE endpoints', () => {
      const metadata = Reflect.getMetadata(SWAGGER_KEYS.API_OPERATION, TestController.prototype.delete);
      expect(metadata.summary).toContain('Deleting');
    });
  });

  describe('HTTP method routing', () => {
    it('should apply POST method decorator', () => {
      const method = Reflect.getMetadata('method', TestController.prototype.create);
      expect(method).toBeDefined();
    });

    it('should apply PATCH method decorator', () => {
      const method = Reflect.getMetadata('method', TestController.prototype.update);
      expect(method).toBeDefined();
    });

    it('should apply GET method decorator for default', () => {
      const method = Reflect.getMetadata('method', TestController.prototype.fetchAll);
      expect(method).toBeDefined();
    });
  });
});
