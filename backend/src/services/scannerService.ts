import { Prisma, PrismaClient, ExceptionSeverity, ExceptionStatus, PunchType, PunchSource } from "@prisma/client";
import { evaluateTimecard, TimecardEvaluationContext } from "../engine/evaluator";
import { LeaveContext, PunchInput, ShiftContext } from "../engine/timeMath";

const prisma = new PrismaClient();

function netMinutes(punches: PunchInput[]): number {
  const ins = punches.filter((p) => p.punchType === "IN").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const outs = punches.filter((p) => p.punchType === "OUT").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (!ins.length || !outs.length) return 0;
  let gross = (outs[0].timestamp.getTime() - ins[0].timestamp.getTime()) / 60000;
  if (gross < 0) gross += 1440;
  const starts = punches.filter((p) => p.punchType === "BREAK_START").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ends = punches.filter((p) => p.punchType === "BREAK_END").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let breaks = 0;
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    let duration = (ends[i].timestamp.getTime() - starts[i].timestamp.getTime()) / 60000;
    if (duration < 0) duration += 1440;
    breaks += duration;
  }
  return Math.max(0, Math.round(gross - breaks));
}

export async function runFullTimecardScan(): Promise<{ scanned: number; createdOrUpdated: number }> {
  const activePolicies = await prisma.policyRule.findMany({
    select: { policyCode: true, thresholdJson: true },
  });
  const employees = await prisma.employee.findMany({
    include: {
      shifts: { orderBy: [{ date: "asc" }, { scheduledStart: "asc" }] },
      punchLogs: { orderBy: { timestamp: "asc" } },
      leaveRequests: true,
    },
  });

  let scanned = 0;
  let createdOrUpdated = 0;

  for (const employee of employees) {
    for (let i = 0; i < employee.shifts.length; i++) {
      const shift = employee.shifts[i];
      const dailyPunches = employee.punchLogs.filter((p) => p.date === shift.date);
      const punches: PunchInput[] = dailyPunches.map((p) => ({
        punchType: p.punchType as PunchType,
        timestamp: p.timestamp,
        date: p.date,
        source: p.source as PunchSource,
      }));

      const date = new Date(`${shift.date}T00:00:00Z`);
      const monday = new Date(date);
      monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const mondayString = monday.toISOString().slice(0, 10);
      let priorMinutes = 0;
      for (const priorShift of employee.shifts) {
        if (priorShift.date >= mondayString && priorShift.date < shift.date) {
          const priorPunches = employee.punchLogs
            .filter((p) => p.date === priorShift.date)
            .map((p) => ({ punchType: p.punchType as PunchType, timestamp: p.timestamp }));
          priorMinutes += netMinutes(priorPunches);
        }
      }

      const approvedLeaves: LeaveContext[] = employee.leaveRequests
        .filter((leave) => leave.status === "APPROVED")
        .map((leave) => ({
          startDate: leave.startDate,
          endDate: leave.endDate,
          status: "APPROVED",
          leaveType: leave.leaveType as LeaveContext["leaveType"],
        }));

      const shiftContext: ShiftContext = {
        id: shift.id,
        employeeId: shift.employeeId,
        date: shift.date,
        scheduledStart: shift.scheduledStart,
        scheduledEnd: shift.scheduledEnd,
        expectedMinutes: shift.expectedMinutes,
        isWeeklyOff: shift.isWeeklyOff,
      };

      const context: TimecardEvaluationContext = {
        shift: shiftContext,
        approvedLeaves,
        weeklyWorkedMinutesBeforeToday: priorMinutes,
        previousShift: i > 0
          ? {
              date: employee.shifts[i - 1].date,
              outTimestamp: employee.punchLogs
                .filter((p) => p.date === employee.shifts[i - 1].date && p.punchType === "OUT")
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]?.timestamp
                ?? employee.shifts[i - 1].scheduledEnd,
            }
          : undefined,
      };

      const anomalies = evaluateTimecard(punches, context, activePolicies);
      scanned++;
      for (const anomaly of anomalies) {
        const approvedExisting = await prisma.timecardException.findFirst({
          where: {
            employeeId: employee.id,
            date: shift.date,
            anomalyCode: anomaly.anomalyCode,
            status: "APPROVED",
          },
        });
        if (approvedExisting) continue;
        const existing = await prisma.timecardException.findFirst({
          where: { employeeId: employee.id, date: shift.date, anomalyCode: anomaly.anomalyCode, status: "OPEN" },
        });
        const severity = anomaly.severity as ExceptionSeverity;
        if (existing) {
          await prisma.timecardException.update({
            where: { id: existing.id },
            data: {
              severity,
              status: "OPEN" as ExceptionStatus,
              deterministicDetailsJson: anomaly.deterministicDetails as Prisma.InputJsonValue,
            },
          });
        } else {
          await prisma.timecardException.create({
            data: {
              employeeId: employee.id,
              date: shift.date,
              anomalyCode: anomaly.anomalyCode,
              severity,
              status: "OPEN",
              deterministicDetailsJson: anomaly.deterministicDetails as Prisma.InputJsonValue,
            },
          });
        }
        createdOrUpdated++;
      }
    }
  }

  return { scanned, createdOrUpdated };
}
