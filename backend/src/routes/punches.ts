import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { evaluateTimecard } from "../engine/evaluator";
import type { LeaveContext, PunchInput, ShiftContext } from "../engine/timeMath";
import { requireEmployeePunchAccess } from "../middleware/employeePunchAccess";

export const punchesRouter = Router();

punchesRouter.post("/api/punches", requireEmployeePunchAccess, async (request, response, next) => {
  try {
    const parsed = z.object({
      employeeId: z.string().min(1),
      punchType: z.enum(["IN", "BREAK_START", "BREAK_END", "OUT"]),
      timestamp: z.string().datetime(),
      source: z.enum(["BIOMETRIC", "WEB_PORTAL", "HR_MANUAL", "EMPLOYEE"]).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid punch", details: parsed.error.flatten() });

    const source = "EMPLOYEE" as const;

    const timestamp = new Date(parsed.data.timestamp);
    const date = timestamp.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (date !== today) {
      return response.status(400).json({ error: "Employees can only log punches for the current date." });
    }
    {
      const approvedLeave = await prisma.leaveRequest.findFirst({
        where: {
          employeeId: parsed.data.employeeId,
          status: "APPROVED",
          startDate: { lte: today },
          endDate: { gte: today },
        },
      });
      if (approvedLeave) {
        return response.status(409).json({ error: "Punch blocked: You are on approved leave today. If your leave was cancelled, ask HR to update your leave status first." });
      }
    }

    const punch = await prisma.punchLog.create({
      data: {
        employeeId: parsed.data.employeeId,
        date,
        punchType: parsed.data.punchType,
        timestamp,
        source,
      },
    });

    const [shift, allPunches, approvedLeaves, activePolicies] = await Promise.all([
      prisma.shift.findFirst({ where: { employeeId: parsed.data.employeeId, date } }),
      prisma.punchLog.findMany({ where: { employeeId: parsed.data.employeeId, date }, orderBy: { timestamp: "asc" } }),
      prisma.leaveRequest.findMany({ where: { employeeId: parsed.data.employeeId, status: "APPROVED" } }),
      prisma.policyRule.findMany({ select: { policyCode: true, thresholdJson: true } }),
    ]);
    let flaggedAnomalies: string[] = [];
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
      const approved: LeaveContext[] = approvedLeaves.map((leave) => ({
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
      const anomalies = evaluateTimecard(
        enginePunches,
        { shift: contextShift, approvedLeaves: approved, weeklyWorkedMinutesBeforeToday: 0 },
        activePolicies,
      );
      flaggedAnomalies = anomalies.map((anomaly) => anomaly.anomalyCode);
      for (const anomaly of anomalies) {
        const resolvedExisting = await prisma.timecardException.findFirst({
          where: {
            employeeId: parsed.data.employeeId,
            date,
            anomalyCode: anomaly.anomalyCode,
            status: "APPROVED",
          },
        });
        if (resolvedExisting) continue;
        const existing = await prisma.timecardException.findFirst({
          where: { employeeId: parsed.data.employeeId, date, anomalyCode: anomaly.anomalyCode, status: "OPEN" },
        });
        if (existing) {
          await prisma.timecardException.update({
            where: { id: existing.id },
            data: { severity: anomaly.severity, deterministicDetailsJson: anomaly.deterministicDetails as Prisma.InputJsonObject },
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

    response.status(201).json({ punch, status: "RECORDED", deterministicEvaluationTriggered: Boolean(shift), flaggedAnomalies });
  } catch (error) {
    next(error);
  }
});
