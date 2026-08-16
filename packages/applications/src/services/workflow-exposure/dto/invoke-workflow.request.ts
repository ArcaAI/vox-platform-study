import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * Body of `POST /api/v1/workflows/:slug/invoke` (TASK-722 Task 6).
 *
 * Deliberately the ONLY field. `tenantId` is NEVER accepted here (S-3 —
 * resolved from the authenticated principal); the global `ValidationPipe`
 * runs `forbidNonWhitelisted`, so any other body field is a 400, not a
 * silently-ignored extra.
 *
 * There is currently no per-definition declared input JSON Schema to
 * validate `input` against — `WorkflowDefinition` has no
 * `input`/`context_binding` column anywhere in the schema, and TASK-734's
 * own contract audit (§7) found no delivered `configSchema` contract in
 * either language to build one against. `input` is therefore accepted as an
 * opaque object and forwarded verbatim; schema validation is a follow-on
 * once a node type that actually declares an input contract exists.
 */
export class InvokeWorkflowRequest {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Opaque invocation input, forwarded to the interpreter run. No declared per-definition schema exists yet — see the class doc.',
    example: {},
  })
  @IsObject()
  input: Record<string, unknown>;
}
