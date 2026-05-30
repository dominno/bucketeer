// Express 4 does NOT forward rejected promises from async handlers to the
// error middleware. Wrap every async route handler so rejections become clean
// JSON error responses instead of hung requests / unhandledRejection crashes.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
