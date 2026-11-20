import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  punchLog: { create: vi.fn(), findMany: vi.fn() },
  shift: { findFirst: vi.fn() },
  leaveRequest: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  employee: { findUnique: vi.fn() },
  policyRule: { findMany: vi.fn() },
}));

vi.mock("../src/lib/prisma", () => ({ prisma: prismaMock }));

import { punchesRouter } from "../src/routes/punches";
import { leavesRouter } from "../src/routes/leaves";

const secret = process.env.AUTH_SECRET ?? "chronopact-development-secret";
let baseUrl = "";
let server: Server;

function tokenFor(sub: string, role: "EMPLOYEE" | "HR_ADMIN"): string {
  const payload = Buffer.from(JSON.stringify({ sub, role, exp: Date.now() + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function todayIst(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

async function postLeave(token: string, startDate: string, endDate = startDate) {
  return fetch(`${baseUrl}/api/leaves`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId: "employee-1", leaveType: "CASUAL", startDate, endDate, reason: "Personal leave" }),
  });
}

async function postPunch(token: string, employeeId = "employee-1") {
  return fetch(`${baseUrl}/api/punches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId, punchType: "IN", timestamp: new Date().toISOString() }),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(punchesRouter);
  app.use(leavesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.punchLog.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "punch-1", ...data }));
  prismaMock.punchLog.findMany.mockResolvedValue([]);
  prismaMock.shift.findFirst.mockResolvedValue(null);
  prismaMock.leaveRequest.findFirst.mockResolvedValue(null);
  prismaMock.leaveRequest.findMany.mockResolvedValue([]);
  prismaMock.policyRule.findMany.mockResolvedValue([]);
  prismaMock.employee.findUnique.mockResolvedValue({ id: "employee-1" });
  prismaMock.leaveRequest.findFirst.mockResolvedValue(null);
  prismaMock.leaveRequest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "leave-1", ...data }));
});

describe("employee-only live punch access", () => {
  it("rejects an HR_ADMIN token with 403 before writing a punch", async () => {
    const response = await postPunch(tokenFor("hr-admin", "HR_ADMIN"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "HR Admins are not permitted to clock in or clock out on behalf of employees. Flagged anomalies must be resolved through the audited Exception Resolution workflow.",
    });
    expect(prismaMock.punchLog.create).not.toHaveBeenCalled();
  });

  it("allows an EMPLOYEE token to record their own live punch", async () => {
    const response = await postPunch(tokenFor("employee-1", "EMPLOYEE"));

    expect(response.status).toBe(201);
    expect(prismaMock.punchLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ employeeId: "employee-1", source: "EMPLOYEE" }),
    }));
  });

  it("rejects an EMPLOYEE token targeting another employee", async () => {
    const response = await postPunch(tokenFor("employee-1", "EMPLOYEE"), "employee-2");

    expect(response.status).toBe(403);
    expect(prismaMock.punchLog.create).not.toHaveBeenCalled();
  });
});

describe("employee-only leave creation and IST dates", () => {
  const employeeToken = () => tokenFor("employee-1", "EMPLOYEE");

  it("rejects a past leave date with HTTP 400", async () => {
    const yesterday = new Date(`${todayIst()}T00:00:00+05:30`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const pastDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(yesterday);
    const response = await postLeave(employeeToken(), pastDate);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Leave requests cannot be submitted for past dates. Please choose today or a future date (IST)." });
    expect(prismaMock.leaveRequest.create).not.toHaveBeenCalled();
  });

  it("allows today or a future date for an authenticated employee", async () => {
    const response = await postLeave(employeeToken(), todayIst());

    expect(response.status).toBe(201);
    expect(prismaMock.leaveRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ employeeId: "employee-1", startDate: todayIst() }),
    }));
  });

  it("rejects HR Admin leave submissions", async () => {
    const response = await postLeave(tokenFor("hr-admin", "HR_ADMIN"), todayIst());

    expect(response.status).toBe(403);
    expect(prismaMock.leaveRequest.create).not.toHaveBeenCalled();
  });
});
