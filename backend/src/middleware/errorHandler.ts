import type { Request, Response, NextFunction } from 'express';

// Generic Express error handler to ensure consistent JSON responses.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const message =
    err instanceof Error ? err.message : 'Unexpected error processing request';
  // A rejected CORS origin is a client error, not a server fault. Left at 500 it
  // triggered an alert email for every scanner probing /graphql, /v1/graphql etc.
  // with a spoofed Origin header — constant background noise on a public API.
  const isCorsRejection = err instanceof Error && /not allowed by CORS/.test(err.message);
  const status = isCorsRejection
    ? 403
    : (err instanceof Error && 'status' in err ? (err as { status: number }).status : 500);

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({ error: message });
};
