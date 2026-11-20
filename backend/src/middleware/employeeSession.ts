import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../routes/auth";

export function requireEmployeeSession(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = token ? verifyToken(token) : null;
  const suppliedEmployeeId = request.body?.employeeId;

  if (
    payload?.role !== "EMPLOYEE"
    || typeof payload.sub !== "string"
    || (suppliedEmployeeId !== undefined && suppliedEmployeeId !== payload.sub)
  ) {
    response.status(403).json({ error: "Only authenticated employees may submit leave requests for themselves." });
    return;
  }

  response.locals.employeeId = payload.sub;
  next();
}
