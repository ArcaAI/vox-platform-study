import { extractHttpStatus } from '../query-client';

describe('extractHttpStatus — TASK-234', () => {
  it('should extract status from AdminApiError-like error with .status', () => {
    const error = { status: 401, message: 'Unauthorized' };
    expect(extractHttpStatus(error)).toBe(401);
  });

  it('should extract status from error with .response.status', () => {
    const error = { response: { status: 403 } };
    expect(extractHttpStatus(error)).toBe(403);
  });

  it('should extract status from AgenticError with .context.status', () => {
    const error = {
      name: 'AgenticError',
      code: 'AUTHENTICATION_ERROR',
      context: { status: 401, endpoint: '/users' },
    };
    expect(extractHttpStatus(error)).toBe(401);
  });

  it('should detect AUTHENTICATION_ERROR code as 401', () => {
    const error = {
      name: 'AgenticError',
      code: 'AUTHENTICATION_ERROR',
      message: 'HTTP 401: Unauthorized',
    };
    expect(extractHttpStatus(error)).toBe(401);
  });

  it('should return undefined for errors with no status info', () => {
    const error = new Error('Network failure');
    expect(extractHttpStatus(error)).toBeUndefined();
  });

  it('should extract 500 from context.status', () => {
    const error = {
      code: 'API_ERROR',
      context: { status: 500 },
    };
    expect(extractHttpStatus(error)).toBe(500);
  });
});
