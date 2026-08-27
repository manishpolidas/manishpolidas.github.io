import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not await handlers; this forwards rejections to next(). */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
