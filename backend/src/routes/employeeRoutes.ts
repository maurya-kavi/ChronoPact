import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { evaluateTimecard } from "../engine/evaluator";
import { LeaveContext, PunchInput, ShiftContext } from "../engine/timeMath";
import { runFullTimecardScan } from "../services/scannerService";

export const employeeRouter = Router();

const punchSchema = z.object({
  employeeId: z.string().min(1),
  punchType: z.enum(["IN", "BREAK_START", "BREAK_END", "OUT"]),
  timestamp: z.string().datetime(),
  source: z.enum(["BIOMETRIC", "WEB_PORTAL", "HR_MANUAL"]).default("WEB_PORTAL"),
});

const leaveSchema = z.object({
  employeeId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  leaveType: z.enum(["SICK", "CASUAL", "EARNED"]),
  reason: z.string().min(1),
});

const employeeSchema = z.object({
  empCode: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  department: z.string().min(1),
  region: z.enum(["IN", "US"]),
  hourlyRate: z.number().positive(),
});

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

employeeRouter.get("/api/employees", async (_request, response, next) => {
  try {
    const employees = await prisma.employee.findMany({ orderBy: { empCode: "asc" } });
    response.json(employees);
  } catch (error) {
    next(error);
  }
});

employeeRouter.post("/api/employees", async (request, response, next) => {
  try {
    const parsed = employeeSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid employee", details: parsed.error.flatten() });

    const employee = await prisma.employee.create({ data: parsed.data });
    const shifts = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + i);
      const dateString = date.toISOString().slice(0, 10);
      shifts.push({
        employeeId: employee.id,
        date: dateString,
        scheduledStart: new Date(`${dateString}T09:00:00.000Z`),
        scheduledEnd: new Date(`${dateString}T17:00:00.000Z`),
        expectedMinutes: 480,
        isWeeklyOff: i === 6,
      });
    }
    await prisma.shift.createMany({ data: shifts });
    response.status(201).json({ employee, shiftsCreated: shifts.length });
  } catch (error) {
    next(error);
  }
});

employeeRouter.get("/api/employees/:id/dashboard", async (request, response, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: request.params.id } });
    if (!employee) return response.status(404).json({ error: "Employee not found" });
    const date = todayString();
    const [todayShift, recentPunches, leaveRequests, exceptions] = await Promise.all([
      prisma.shift.findFirst({ where: { employeeId: employee.id, date } }),
      prisma.punchLog.findMany({ where: { employeeId: employee.id }, orderBy: { timestamp: "desc" }, take: 20 }),
      prisma.leaveRequest.findMany({ where: { employeeId: employee.id }, orderBy: { startDate: "desc" }, take: 20 }),
      prisma.timecardException.findMany({
        where: { employeeId: employee.id, status: { in: ["OPEN", "PROPOSED"] } },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    response.json({ employee, todayShift, recentPunches, leaveRequests, exceptions });
  } catch (error) {
    next(error);
  }
});

employeeRouter.post("/api/punches", async (request, response, next) => {
  try {
    const parsed = punchSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid punch", details: parsed.error.flatten() });

    const timestamp = new Date(parsed.data.timestamp);
    const date = timestamp.toISOString().slice(0, 10);
    const punch = await prisma.punchLog.create({
      data: { employeeId: parsed.data.employeeId, date, punchType: parsed.data.punchType, timestamp, source: parsed.data.source },
    });

    const [shift, allPunches, leaves] = await Promise.all([
      prisma.shift.findFirst({ where: { employeeId: parsed.data.employeeId, date } }),
      prisma.punchLog.findMany({ where: { employeeId: parsed.data.employeeId, date }, orderBy: { timestamp: "asc" } }),
      prisma.leaveRequest.findMany({ where: { employeeId: parsed.data.employeeId, status: "APPROVED" } }),
    ]);
    if (shift) {
      const contextShift: ShiftContext = {
        id: shift.id,
        employeeId: shift.employeeId,
        date: shift.date,
        scheduledStart: shift.scheduledStart,
        scheduledEnd: shift.scheduledEnd,
        expectedMinutes: shift.expectedMinutes,
        isWeeklyOff: shift.isWeeklyOff,
      };
      const approvedLeaves: LeaveContext[] = leaves.map((leave) => ({
        startDate: leave.startDate,
        endDate: leave.endDate,
        status: "APPROVED",
        leaveType: leave.leaveType,
      }));
      const enginePunches: PunchInput[] = allPunches.map((item) => ({
        punchType: item.punchType,
        timestamp: item.timestamp,
        date: item.date,
        source: item.source,
      }));
      const anomalies = evaluateTimecard(enginePunches, { shift: contextShift, approvedLeaves, weeklyWorkedMinutesBeforeToday: 0 });
      for (const anomaly of anomalies) {
        const existing = await prisma.timecardException.findFirst({
          where: { employeeId: parsed.data.employeeId, date, anomalyCode: anomaly.anomalyCode, status: "OPEN" },
        });
        if (existing) {
          await prisma.timecardException.update({
            where: { id: existing.id },
            data: {
              severity: anomaly.severity,
              deterministicDetailsJson: anomaly.deterministicDetails as Prisma.InputJsonObject,
            },
          });
        } else {
          await prisma.timecardException.create({
            data: {
            employeeId: parsed.data.employeeId,
            date,
            anomalyCode: anomaly.anomalyCode,
            severity: anomaly.severity,
            status: "OPEN",
            deterministicDetailsJson: anomaly.deterministicDetails as Prisma.InputJsonObject,
            },
          });
        }
      }
    }
    response.status(201).json({
      punch,
      status: "RECORDED",
      deterministicEvaluationTriggered: Boolean(shift),
      flaggedAnomalies: shift
        ? evaluateTimecard(
            allPunches.map((item) => ({
              punchType: item.punchType,
              timestamp: item.timestamp,
              date: item.date,
              source: item.source,
            })),
            {
              shift: {
                id: shift.id,
                employeeId: shift.employeeId,
                date: shift.date,
                scheduledStart: shift.scheduledStart,
                scheduledEnd: shift.scheduledEnd,
                expectedMinutes: shift.expectedMinutes,
                isWeeklyOff: shift.isWeeklyOff,
              },
              approvedLeaves: leaves.map((leave) => ({
                startDate: leave.startDate,
                endDate: leave.endDate,
                status: "APPROVED",
                leaveType: leave.leaveType,
              })),
              weeklyWorkedMinutesBeforeToday: 0,
            },
          ).map((anomaly) => anomaly.anomalyCode)
        : [],
    });
  } catch (error) {
    next(error);
  }
});

employeeRouter.post("/api/leaves", async (request, response, next) => {
  try {
    const parsed = leaveSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid leave request", details: parsed.error.flatten() });
    const leave = await prisma.leaveRequest.create({
      data: { ...parsed.data, status: "PENDING" },
    });
    if (leave.status === "APPROVED") await runFullTimecardScan();
    response.status(201).json(leave);
  } catch (error) {
    next(error);
  }
});
