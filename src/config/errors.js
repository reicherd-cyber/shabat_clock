// [D4] API error envelope: {"error":{"code","message"}} + optional fields map.
export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const errors = {
  validation: (message = 'Invalid input', fields) => new ApiError(400, 'VALIDATION', message, fields),
  unauthenticated: (message = 'Authentication required') => new ApiError(401, 'UNAUTHENTICATED', message),
  badCode: () => new ApiError(401, 'BAD_CODE', 'Wrong or expired code'),
  forbidden: (message = 'Forbidden') => new ApiError(403, 'FORBIDDEN', message),
  notFound: (code = 'NOT_FOUND', message = 'Not found') => new ApiError(404, code, message),
  conflict: (code, message) => new ApiError(409, code, message),
  rateLimited: () => new ApiError(429, 'RATE_LIMITED', 'Too many requests'),
};

// Express error handler emitting the [D4] envelope.
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.fields) body.error.fields = err.fields;
    return res.status(err.status).json(body);
  }
  // body-parser failures are the client's fault, not a server error: malformed
  // JSON → 400, oversized body → 413 — and neither is worth a stack in the log.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Malformed JSON body' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
