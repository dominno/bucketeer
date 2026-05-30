// Uniform error handling: an AppError type for our own 4xx/validation errors,
// a mapper from AWS SDK v3 / S3 errors to clean HTTP statuses, and the Express
// error middleware that emits a single JSON envelope and never leaks secrets.

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const httpError = (status, code, message) => new AppError(status, code, message);

// Pull a stable error identifier out of an SDK v3 error. v3 puts it on `.name`,
// older shapes use `.Code`; fall back to the metadata status.
function errIdentifier(err) {
  return err?.name || err?.Code || err?.code || '';
}

// Map an S3 / SDK error to { status, code, message }. iDrive E2 follows S3
// semantics, including the quirk that listing a non-existent bucket returns 403
// AccessDenied rather than 404 NoSuchBucket.
export function mapS3Error(err) {
  const id = errIdentifier(err);
  const httpStatus = err?.$metadata?.httpStatusCode;

  switch (id) {
    case 'NoSuchKey':
    case 'NotFound':
    case 'NoSuchUpload':
      return { status: 404, code: id, message: 'The requested object does not exist.' };
    case 'NoSuchBucket':
      return { status: 404, code: id, message: 'The requested bucket does not exist.' };
    case 'AccessDenied':
    case 'Forbidden':
      return {
        status: 403,
        code: 'AccessDenied',
        message:
          'Access denied. The credentials lack permission for this operation, or (on iDrive E2) the bucket may not exist.',
      };
    case 'InvalidAccessKeyId':
      return { status: 401, code: id, message: 'Invalid access key ID for this profile.' };
    case 'SignatureDoesNotMatch':
      return {
        status: 401,
        code: id,
        message:
          'Signature mismatch. The secret access key or region is likely incorrect for this profile.',
      };
    case 'Throttling':
    case 'ThrottlingException':
    case 'SlowDown':
    case 'RequestLimitExceeded':
      return { status: 429, code: id, message: 'The storage provider is throttling requests. Try again shortly.' };
    case 'ValidationError':
    case 'InvalidRequest':
    case 'InvalidArgument':
      return { status: 400, code: id, message: err?.message || 'Invalid request.' };
    default:
      if (httpStatus && httpStatus >= 400) {
        return { status: httpStatus, code: id || 'STORAGE_ERROR', message: err?.message || 'Storage error.' };
      }
      return { status: 500, code: id || 'INTERNAL', message: err?.message || 'Internal server error.' };
  }
}

// Final Express error handler. Order matters: register last, after all routes.
// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, next) {
  let status;
  let code;
  let message;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else {
    const mapped = mapS3Error(err);
    status = mapped.status;
    code = mapped.code;
    message = mapped.message;
  }

  // Server-side log without secrets or full SDK request config.
  const requestId = err?.$metadata?.requestId;
  console.error(
    `[error] ${req.method} ${req.path} -> ${status} ${code}` +
      (requestId ? ` (reqId ${requestId})` : '') +
      `: ${err?.message || message}`,
  );

  if (res.headersSent) {
    // A stream already started writing (e.g. a download). Can't send JSON now.
    return next(err);
  }

  res.status(status).json({
    error: {
      code,
      message,
      requestId,
      profileId: req.profileId,
    },
  });
}
