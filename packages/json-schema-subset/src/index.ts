/**
 * @arcaai/json-schema-subset
 *
 * The constrained JSON Schema (draft 2020-12) subset a tenant may author for a
 * `ConsultationContextSchema`, plus its value evaluator. Zero runtime
 * dependencies — consumed by `@arcaai/applications` (authoritative server
 * enforcement), `@arcaai/vox` (client-side fast-fail) and
 * `@arcaai/admin-console` (editor preview + payload tester).
 */

export { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, authorableJsonSchemaProblems, jsonSchemaValueProblems } from './json-schema-subset';
