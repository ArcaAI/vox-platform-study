export * from './data-not-found.filter';
export * from './consent.filter';
export * from './error-envelope';
export * from './http-exception-envelope.filter';
// the downstream-failure classifier + the only client-facing body
// builder for a failed call to a Python service. Not a Nest filter: it is the
// pure boundary logic `ExceptionInterceptor` applies (and that the three proxy
// controllers source their STATUS from, so they can keep their frozen v1 body
// shapes without ever disagreeing with the gateway about what a status means).
export * from './downstream-error';
