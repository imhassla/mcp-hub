import { describe, expect, it } from 'vitest';
import { describeHttpError } from '../src/http-errors.js';

describe('describeHttpError', () => {
  it('returns stable JSON-safe responses without exposing parser details', () => {
    expect(describeHttpError({ status: 400, type: 'entity.parse.failed', message: 'secret parser detail' })).toEqual({
      status: 400,
      body: {
        success: false,
        error_code: 'INVALID_JSON_BODY',
        error: 'Request body must be valid JSON',
      },
    });
    expect(describeHttpError({ statusCode: 413 })).toEqual({
      status: 413,
      body: {
        success: false,
        error_code: 'REQUEST_BODY_TOO_LARGE',
        error: 'Request body exceeds size limit',
      },
    });
    expect(describeHttpError(new Error('database path'))).toEqual({
      status: 500,
      body: {
        success: false,
        error_code: 'HTTP_REQUEST_FAILED',
        error: 'Internal server error',
      },
    });
  });
});
