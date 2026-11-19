import { Router } from "express";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export const authRouter = Router();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const actual = Buffer.from(scryptSync(password, parts[1], 64).toString("hex"), "hex");
  const expected = Buffer.from(parts[2], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signPayload(payload: Record<string, unknown>): string {
  const secret = process.env.AUTH_SECRET ?? "chronopact-development-secret";
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const secret = process.env.AUTH_SECRET ?? "chronopact-development-secret";
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  if (parts[1].length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sanitize(employee: Record<string, unknown>) {
  const { passwordHash: _passwordHash, ...profile } = employee;
  return profile;
}

authRouter.post("/api/auth/register", async (request, response, next) => {
  try {
    const parsed = z.object({
      empCode: z.string().trim().min(1),
      password: z.string().min(6),
      confirmPassword: z.string().min(6),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid registration details", details: parsed.error.flatten() });
    if (parsed.data.password !== parsed.data.confirmPassword) return response.status(400).json({ error: "Password and confirm password must match" });

    const employees = await prisma.employee.findMany();
    const employee = employees.find((item) => item.empCode.trim().toLowerCase() === parsed.data.empCode.toLowerCase());
    if (!employee) return response.status(404).json({ error: "Employee ID not provisioned by HR. Please contact HR Admin first." });
    if (employee.isRegistered) return response.status(409).json({ error: "Account already activated. Please log in." });

    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: { passwordHash: hashPassword(parsed.data.password), isRegistered: true, status: "ACTIVATED" },
    });
    response.status(201).json({
      token: signPayload({ sub: updated.id, role: "EMPLOYEE", empCode: updated.empCode }),
      employee: sanitize(updated as unknown as Record<string, unknown>),
      role: "EMPLOYEE",
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/api/auth/login", async (request, response, next) => {
  try {
    const parsed = z.object({ empCode: z.string().trim().min(1), password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid employee credentials" });
    const employees = await prisma.employee.findMany();
    const employee = employees.find((item) => item.empCode.trim().toLowerCase() === parsed.data.empCode.toLowerCase());
    if (!employee || !employee.isRegistered || !employee.passwordHash || !verifyPassword(parsed.data.password, employee.passwordHash)) {
      return response.status(401).json({ error: "Invalid employee ID or password" });
    }
    response.json({
      token: signPayload({ sub: employee.id, role: "EMPLOYEE", empCode: employee.empCode }),
      employee: sanitize(employee as unknown as Record<string, unknown>),
      role: "EMPLOYEE",
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/api/auth/hr-login", (request, response) => {
  const parsed = z.object({ hrEmail: z.string().email(), password: z.string().min(1) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Invalid HR credentials" });
  const email = process.env.HR_ADMIN_EMAIL ?? "admin@chronopact.io";
  const password = process.env.HR_ADMIN_PASSWORD ?? "Admin@123";
  if (parsed.data.hrEmail.toLowerCase() !== email.toLowerCase() || parsed.data.password !== password) {
    return response.status(401).json({ error: "Invalid HR administrator credentials" });
  }
  response.json({
    token: signPayload({ sub: "hr-admin", role: "HR_ADMIN", hrEmail: email }),
    employee: null,
    role: "HR_ADMIN",
  });
});

authRouter.get("/api/auth/me", async (request, response, next) => {
  try {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = token ? verifyToken(token) : null;
    if (!payload) return response.status(401).json({ error: "Unauthorized" });
    if (payload.role === "HR_ADMIN") return response.json({ role: "HR_ADMIN", profile: { hrEmail: payload.hrEmail } });
    const employee = await prisma.employee.findUnique({ where: { id: String(payload.sub) } });
    if (!employee) return response.status(404).json({ error: "Employee not found" });
    response.json({ role: "EMPLOYEE", profile: sanitize(employee as unknown as Record<string, unknown>) });
  } catch (error) {
    next(error);
  }
});
