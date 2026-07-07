export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function validation(code, message, fields) {
  return new ApiError(400, code || 'VALIDATION', message || 'Validation failed', fields);
}

export function notFound(code = 'NOT_FOUND', message = 'Not found') {
  return new ApiError(404, code, message);
}

export function conflict(code = 'CONFLICT', message = 'Conflict') {
  return new ApiError(409, code, message);
}

export function unauthenticated(message = 'Unauthenticated') {
  return new ApiError(401, 'UNAUTHENTICATED', message);
}

export function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  const body = {
    error: {
      code: err.code || 'INTERNAL',
      message: status >= 500 ? 'Internal server error' : err.message,
    },
  };
  if (err.fields) body.error.fields = err.fields;
  if (status >= 500) console.error(err);
  return res.status(status).json(body);
}
