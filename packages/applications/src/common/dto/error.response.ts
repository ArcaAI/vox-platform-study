import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorResponse {
  @ApiProperty({ example: 400 })
  readonly statusCode: number;

  @ApiProperty({ example: 'Validation Error' })
  readonly message: string;

  @ApiProperty({ example: 'Bad Request' })
  readonly error: string;

  @ApiProperty({ example: '018f67d0-323e-7635-8804-962b005ace10' })
  readonly correlationId: string;

  @ApiProperty({
    example: ['incorrect email'],
    description: 'Optional list of sub-errors',
    nullable: true,
    required: false,
  })
  readonly subErrors?: string[];

  // Documentation-only additions (H-2 unified error envelope,
  // `apps/api/src/filters/error-envelope.ts`): `ExceptionInterceptor` spreads
  // `code`/`details` onto every error body it produces, but does so OUTSIDE
  // this class's constructor call (`{ ...new ApiErrorResponse({...}), code,
  // details }`), so today no caller ever passes them INTO the constructor.
  // Declaring + optionally copying them here is therefore purely additive —
  // it documents the real wire shape without changing what any existing
  // caller receives.
  @ApiPropertyOptional({
    example: 'HTTP.NOT_FOUND',
    description: "The envelope's machine-readable code (domain code when the error carries one, else the HTTP-status fallback).",
  })
  readonly code?: string;

  @ApiPropertyOptional({
    example: ['incorrect email'],
    description: "The envelope's generic slot for per-field/sub-error detail (class-validator failures surface `subErrors` here too).",
  })
  readonly details?: string[];

  constructor(body: ApiErrorResponse) {
    this.statusCode = body.statusCode;
    this.message = body.message;
    this.error = body.error;
    this.correlationId = body.correlationId;
    this.subErrors = body.subErrors;
    this.code = body.code;
    this.details = body.details;
  }
}
