import { ClsServiceManager } from 'nestjs-cls';

export interface SerializedException {
  message: string;
  code: string;
  correlationId: string;
  stack?: string;
  cause?: string;
  metadata?: unknown;
}

// Matches an absolute filesystem path immediately followed by `:<line>:<col>`
// — the shape V8 stack frames use (`/Users/.../file.ts:12:34`,
// `/srv/app/dist/file.js:5:1`). Reduced to `file.ts:12:34` so the response
// body keeps the "which file, which line" debugging value without echoing
// the server's directory layout (F-030).
const STACK_FRAME_ABSOLUTE_PATH = /(?:[a-zA-Z]:)?(\/[^\s():]+):(\d+):(\d+)/g;

function sanitizeStack(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  return stack.replace(STACK_FRAME_ABSOLUTE_PATH, (_match, filePath: string, line: string, col: string) => {
    const base = filePath.split('/').pop() || filePath;
    return `${base}:${line}:${col}`;
  });
}

/**
 * Base class for custom exceptions.
 *
 * @abstract
 * @class ExceptionBase
 * @extends {Error}
 */
export abstract class BaseException extends Error {
  abstract code: string;

  public readonly correlationId: string;

  /**
   * @param {string} message
   * @param {ObjectLiteral} [metadata={}]
   */
  constructor(
    override readonly message: string,
    readonly cause?: Error,
    readonly metadata?: unknown,
  ) {
    super(message);
    // Surfaces the concrete subclass (e.g. `ArgumentInvalidException`) as the
    // stack's first line instead of the generic `Error` every subclass
    // inherits by default — keeps the class useful in logs/observability
    // even after the filesystem-path scrub below.
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
    const cls = ClsServiceManager.getClsService();
    this.correlationId = cls.getId();
  }

  /**
   * By default in NodeJS Error objects are not
   * serialized properly when sending plain objects
   * to external processes. This method is a workaround.
   *
   * The stack is included outside production (never in production), but with
   * every absolute filesystem path reduced to its basename — an HTTP client
   * gets "which file, which line" without the server's directory layout
   * (F-030; staging/test bodies were leaking full absolute paths).
   * https://iaincollins.medium.com/error-handling-in-javascript-a6172ccdf9af
   */
  public toJSON(): SerializedException {
    return {
      message: this.message,
      code: this.code,
      correlationId: this.correlationId,
      stack: process.env['NODE_ENV'] === 'production' ? undefined : sanitizeStack(this.stack),
      cause: this.cause ? JSON.stringify(this.cause) : undefined,
      metadata: this.metadata,
    };
  }
}
