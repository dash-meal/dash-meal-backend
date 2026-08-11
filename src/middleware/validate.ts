import type { Request, Response, NextFunction } from "express";
import { type ZodSchema, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";

type RequestPart = "body" | "query" | "params";

export function validate(schema: ZodSchema, part: RequestPart = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const error = fromZodError(result.error);
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
          details: result.error.flatten(),
        },
      });
      return;
    }
    req[part] = result.data;
    next();
  };
}
