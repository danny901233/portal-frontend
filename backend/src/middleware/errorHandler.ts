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
  const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({ error: message });
};
