import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../routes/auth";

export const employeePunchForbiddenMessage =
  "HR Admins are not permitted to clock in or clock out on behalf of employees. Flagged anomalies must be resolved through the audited Exception Resolution workflow.";

export function requireEmployeePunchAccess(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = token ? verifyToken(token) : null;
  const targetEmployeeId = request.body?.employeeId
    ?? request.params.employeeId
    ?? request.params.id;

  if (
    payload?.role !== "EMPLOYEE"
    || typeof payload.sub !== "string"
    || typeof targetEmployeeId !== "string"
    || payload.sub !== targetEmployeeId
  ) {
    response.status(403).json({ error: employeePunchForbiddenMessage });
    return;
  }

  next();
}
