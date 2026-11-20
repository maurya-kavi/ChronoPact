import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyToken } from "./auth";
import { requireEmployeeSession } from "../middleware/employeeSession";

export const leavesRouter = Router();

leavesRouter.get("/api/leaves", async (request, response, next) => {
  try {
    const status = z.enum(["ALL", "PENDING", "APPROVED", "REJECTED", "CANCELLED"]).catch("ALL").parse(request.query.status);
    const employeeId = typeof request.query.employeeId === "string" ? request.query.employeeId : undefined;
    const leaves = await prisma.leaveRequest.findMany({
      where: {
        ...(status !== "ALL" ? { status: status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" } : {}),
        ...(employeeId ? { employeeId } : {}),
      },
      include: { employee: true },
      orderBy: [{ createdAt: "desc" }, { startDate: "desc" }],
    });
    const enriched = await Promise.all(leaves.map(async (leave) => {
      const punchConflict = await prisma.punchLog.findFirst({
        where: { employeeId: leave.employeeId, date: { gte: leave.startDate, lte: leave.endDate } },
      });
      const overlap = await prisma.leaveRequest.findFirst({
        where: {
          id: { not: leave.id },
          employeeId: leave.employeeId,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: leave.endDate },
          endDate: { gte: leave.startDate },
        },
      });
      return {
        ...leave,
        hasPunchConflict: Boolean(punchConflict),
        hasScheduleOverlap: Boolean(overlap),
      };
    }));
    response.json(enriched);
  } catch (error) {
    next(error);
  }
});

leavesRouter.post("/api/leaves", requireEmployeeSession, async (request, response, next) => {
  try {
    const parsed = z.object({
      employeeId: z.string().optional(),
      leaveType: z.enum(["SICK", "CASUAL", "EARNED"]),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().min(1),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid leave request", details: parsed.error.flatten() });
    const employeeId = response.locals.employeeId as string;
    const todayParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const todayIst = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;
    if (parsed.data.startDate < todayIst) {
      return response.status(400).json({ error: "Leave requests cannot be submitted for past dates. Please choose today or a future date (IST)." });
    }
    if (parsed.data.endDate < parsed.data.startDate) return response.status(400).json({ error: "End date cannot be before start date" });

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return response.status(404).json({ error: "Employee not found" });

    const [punches, overlap] = await Promise.all([
      prisma.punchLog.findMany({ where: { employeeId, date: { gte: parsed.data.startDate, lte: parsed.data.endDate } }, take: 1 }),
      prisma.leaveRequest.findFirst({
        where: {
          employeeId,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: parsed.data.endDate },
          endDate: { gte: parsed.data.startDate },
        },
      }),
    ]);
    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: parsed.data.leaveType,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        reason: parsed.data.reason,
        status: "PENDING",
      },
    });
    response.status(201).json({
      leave,
      warnings: {
        hasPunchConflict: punches.length > 0,
        hasScheduleOverlap: Boolean(overlap),
      },
    });
  } catch (error) {
    next(error);
  }
});

leavesRouter.patch("/api/leaves/:id/status", async (request, response, next) => {
  try {
    const parsed = z.object({
      status: z.enum(["APPROVED", "REJECTED", "CANCELLED"]),
      hrNotes: z.string().optional(),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid leave status", details: parsed.error.flatten() });
    const existing = await prisma.leaveRequest.findUnique({ where: { id: request.params.id } });
    if (!existing) return response.status(404).json({ error: "Leave request not found" });
    const leave = await prisma.leaveRequest.update({
      where: { id: existing.id },
      data: { status: parsed.data.status, hrNotes: parsed.data.hrNotes ?? existing.hrNotes },
    });
    response.json(leave);
  } catch (error) {
    next(error);
  }
});
