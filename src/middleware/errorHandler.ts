import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }

  logger.error({ err, method: req.method, url: req.originalUrl }, "Erreur non gérée");
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Une erreur interne est survenue",
    },
  });
}
