/**
 * Errors of the run plane in the browser SDK (TASK-1039). Names and meanings match
 * `@arcaai/vox-node`'s, so one `catch` reads the same on both sides of the wire.
 */

/** The run ended FAILED or TIMED_OUT. `code` is the gateway's fixed identifier and `message` its fixed label — never run data. */
export class RunFailedError extends Error {
  readonly runId: string;
  readonly status: string;
  readonly code: string;

  constructor(options: { runId: string; status: string; code: string; message: string }) {
    super(options.message);
    this.name = 'RunFailedError';
    this.runId = options.runId;
    this.status = options.status;
    this.code = options.code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A large result was downloaded and its bytes do not match the `sha256` the gateway declared. Nothing is returned from it. */
export class RunResultIntegrityError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`The result of run ${runId} does not match its declared SHA-256 and was discarded.`);
    this.name = 'RunResultIntegrityError';
    this.runId = runId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The result route (or its signed URL) answered something the SDK cannot read as a result. */
export class RunResultError extends Error {
  readonly runId: string;
  readonly status: number;

  constructor(options: { runId: string; status: number; message: string }) {
    super(options.message);
    this.name = 'RunResultError';
    this.runId = options.runId;
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
