import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { JWT_ACCESS_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } from "../shared/index.js";
import type { AuthUser } from "../shared/index.js";

export function signAccessToken(payload: AuthUser): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRES_IN,
  });
}

export function signRefreshToken(payload: { id: string; role: string }): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  });
}

export function verifyRefreshToken(token: string): { id: string; role: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { id: string; role: string };
}
