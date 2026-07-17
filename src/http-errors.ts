export type StableHttpError = {
  status: number;
  body: {
    success: false;
    error_code: 'REQUEST_BODY_TOO_LARGE' | 'INVALID_JSON_BODY' | 'HTTP_REQUEST_FAILED';
    error: string;
  };
};

export function describeHttpError(error: unknown): StableHttpError {
  const typedError = error as { status?: number; statusCode?: number; type?: string } | null | undefined;
  const candidateStatus = Number(typedError?.status || typedError?.statusCode);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
    ? candidateStatus
    : 500;
  const parserType = String(typedError?.type || '');
  const errorCode = status === 413
    ? 'REQUEST_BODY_TOO_LARGE'
    : (status === 400 && parserType === 'entity.parse.failed' ? 'INVALID_JSON_BODY' : 'HTTP_REQUEST_FAILED');
  const message = status === 413
    ? 'Request body exceeds size limit'
    : (errorCode === 'INVALID_JSON_BODY'
      ? 'Request body must be valid JSON'
      : (status >= 500 ? 'Internal server error' : 'HTTP request failed'));

  return {
    status,
    body: { success: false, error_code: errorCode, error: message },
  };
}
