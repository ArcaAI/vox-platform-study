/**
 * Raised for anything this tool refuses to guess at rather than silently
 * emit a wrong or misleading result: an unreachable/non-2xx discovery
 * fetch, a malformed response body, or an authored JSON Schema construct
 * outside the supported subset (`if`/`then`/`else`, an undiscriminated
 * `oneOf`, an unrecognized `type`). `cli.ts` catches this type specifically
 * and prints `error.message` to stderr with exit code 1 — anything else
 * (a genuine bug) is left to crash with its full stack.
 */
export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenError';
  }
}
