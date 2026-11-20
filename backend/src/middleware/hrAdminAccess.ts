import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../routes/auth";

export function requireHrAdmin(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = token ? verifyToken(token) : null;
  if (payload?.role !== "HR_ADMIN") {
    response.status(403).json({ error: "HR Admin access required" });
    return;
  }
  next();
}
