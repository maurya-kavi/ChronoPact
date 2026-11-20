import { Router } from "express";
import { randomBytes, scryptSync } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export const employeesRouter = Router();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

employeesRouter.get("/api/employees", async (_request, response, next) => {
  try {
    response.json(await prisma.employee.findMany({
      include: { shifts: { orderBy: { date: "desc" }, take: 7 } },
      orderBy: { empCode: "asc" },
    }));
  } catch (error) {
    next(error);
  }
});

const provisionSchema = z.object({
  empCode: z.string().trim().min(1),
  name: z.string().trim().min(1),
  email: z.string().email(),
  department: z.string().min(1),
  team: z.string().min(1),
  role: z.string().min(1),
  region: z.enum(["IN", "US"]),
  shiftStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  status: z.string().optional(),
  hourlyRate: z.number().positive().optional(),
});

employeesRouter.post("/api/employees", async (request, response, next) => {
  try {
    const parsed = provisionSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid employee details", details: parsed.error.flatten() });
    const employee = await prisma.employee.create({
      data: {
        empCode: parsed.data.empCode,
        name: parsed.data.name,
        email: parsed.data.email,
        department: parsed.data.department,
        team: parsed.data.team,
        role: parsed.data.role,
        region: parsed.data.region,
        address: parsed.data.address ?? "Not Provided",
        phone: parsed.data.phone ?? "",
        status: parsed.data.status ?? "PENDING_REGISTRATION",
        isRegistered: false,
        passwordHash: null,
        hourlyRate: parsed.data.hourlyRate ?? 25,
      },
    });
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + i);
      const dateString = date.toISOString().slice(0, 10);
      const [startHour, startMinute] = (parsed.data.shiftStart ?? "09:00").split(":").map(Number);
      const [endHour, endMinute] = (parsed.data.shiftEnd ?? "17:00").split(":").map(Number);
      const scheduledStart = new Date(`${dateString}T${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00.000Z`);
      const scheduledEnd = new Date(`${dateString}T${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}:00.000Z`);
      await prisma.shift.create({
        data: {
          employeeId: employee.id,
          date: dateString,
          scheduledStart,
          scheduledEnd,
          expectedMinutes: Math.max(0, Math.round((scheduledEnd.getTime() - scheduledStart.getTime()) / 60000)),
          isWeeklyOff: i === 6,
        },
      });
    }
    response.status(201).json(employee);
  } catch (error) {
    next(error);
  }
});

employeesRouter.patch("/api/employees/:id", async (request, response, next) => {
  try {
    const parsed = z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().optional(),
      department: z.string().min(1).optional(),
      team: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
      region: z.enum(["IN", "US"]).optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      status: z.string().optional(),
      shiftStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      shiftEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      resetActivation: z.boolean().optional(),
      resetPassword: z.string().min(6).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid employee update", details: parsed.error.flatten() });

    const employee = await prisma.employee.findUnique({ where: { id: request.params.id } });
    if (!employee) return response.status(404).json({ error: "Employee not found" });
    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
        ...(parsed.data.department !== undefined ? { department: parsed.data.department } : {}),
        ...(parsed.data.team !== undefined ? { team: parsed.data.team } : {}),
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.region !== undefined ? { region: parsed.data.region } : {}),
        ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
        ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.resetActivation
          ? { isRegistered: false, passwordHash: null, status: "PENDING_REGISTRATION" }
          : {}),
        ...(parsed.data.resetPassword
          ? { passwordHash: hashPassword(parsed.data.resetPassword), isRegistered: true, status: "ACTIVATED" }
          : {}),
      },
    });

    if (parsed.data.shiftStart || parsed.data.shiftEnd) {
      const futureShifts = await prisma.shift.findMany({
        where: { employeeId: employee.id },
        orderBy: { date: "desc" },
        take: 30,
      });
      for (const shift of futureShifts) {
        const date = shift.date;
        const [startHour, startMinute] = (parsed.data.shiftStart ?? new Date(shift.scheduledStart).toISOString().slice(11, 16)).split(":").map(Number);
        const [endHour, endMinute] = (parsed.data.shiftEnd ?? new Date(shift.scheduledEnd).toISOString().slice(11, 16)).split(":").map(Number);
        const start = new Date(`${date}T${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00.000Z`);
        const end = new Date(`${date}T${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}:00.000Z`);
        await prisma.shift.update({
          where: { id: shift.id },
          data: { scheduledStart: start, scheduledEnd: end, expectedMinutes: Math.round((end.getTime() - start.getTime()) / 60000) },
        });
      }
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

employeesRouter.get("/api/employees/:id/report", async (request, response, next) => {
  try {
    const month = z.string().regex(/^\d{4}-\d{2}$/).catch(() => new Date().toISOString().slice(0, 7)).parse(request.query.month);
    const statusFilter = z.enum(["ALL", "MISSING_PUNCH", "OVERTIME", "UNDERTIME", "ON_LEAVE", "EXCEPTION_FLAGGED", "RESOLVED", "CLEAN"]).catch("ALL").parse(request.query.statusFilter);
    const employee = await prisma.employee.findUnique({ where: { id: request.params.id } });
    if (!employee) return response.status(404).json({ error: "Employee not found" });

    const monthStart = `${month}-01`;
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const [shifts, punches, leaves, exceptions] = await Promise.all([
      prisma.shift.findMany({ where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd } }, orderBy: { date: "desc" } }),
      prisma.punchLog.findMany({ where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd } }, orderBy: { timestamp: "asc" } }),
      prisma.leaveRequest.findMany({ where: { employeeId: employee.id, startDate: { lte: monthEnd }, endDate: { gte: monthStart } }, orderBy: { startDate: "desc" } }),
      prisma.timecardException.findMany({ where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd } }, orderBy: { date: "desc" } }),
    ]);

    const dates = new Set<string>();
    shifts.forEach((shift) => dates.add(shift.date));
    punches.forEach((punch) => dates.add(punch.date));
    leaves.forEach((leave) => {
      for (let day = new Date(`${leave.startDate}T00:00:00Z`); day <= new Date(`${leave.endDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
        const date = day.toISOString().slice(0, 10);
        if (date >= monthStart && date <= monthEnd) dates.add(date);
      }
    });
    exceptions.forEach((exception) => dates.add(exception.date));

    const activePolicies = await prisma.policyRule.findMany({ select: { policyCode: true, thresholdJson: true } });
    const dailyThreshold = (activePolicies.find((policy) => policy.policyCode === "POL-OT-01")?.thresholdJson as { dailyHours?: number } | undefined)?.dailyHours ?? 9;

    const rows = [...dates].sort((a, b) => b.localeCompare(a)).map((date) => {
      const shift = shifts.find((item) => item.date === date);
      const dayPunches = punches.filter((punch) => punch.date === date).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const leave = leaves.find((item) => item.status === "APPROVED" && date >= item.startDate && date <= item.endDate);
      const activeExceptions = exceptions.filter(
        (item) => item.date === date && ["OPEN", "PROPOSED", "ESCALATED"].includes(item.status),
      );
      const resolvedExceptions = exceptions.filter(
        (item) => item.date === date && item.status === "APPROVED",
      );
      const unresolvedException = activeExceptions[0] ?? null;
      const firstIn = dayPunches.find((punch) => punch.punchType === "IN");
      const lastOut = [...dayPunches].reverse().find((punch) => punch.punchType === "OUT");
      let netMinutes = 0;
      if (firstIn && lastOut) {
        netMinutes = Math.max(0, (lastOut.timestamp.getTime() - firstIn.timestamp.getTime()) / 60000);
        let breakMinutes = 0;
        for (let i = 0; i < dayPunches.length; i++) {
          if (dayPunches[i].punchType === "BREAK_START") {
            const end = dayPunches.slice(i + 1).find((punch) => punch.punchType === "BREAK_END");
            if (end) breakMinutes += Math.max(0, (end.timestamp.getTime() - dayPunches[i].timestamp.getTime()) / 60000);
          }
        }
        netMinutes = Math.max(0, netMinutes - breakMinutes);
      }
      const netWorkedHours = Number((netMinutes / 60).toFixed(2));
      const overtimeHours = Number(Math.max(0, netWorkedHours - dailyThreshold).toFixed(2));
      const expectedHours = shift ? shift.expectedMinutes / 60 : 8;
      const undertimeHours = lastOut && netWorkedHours < expectedHours - 0.25
        ? Number((expectedHours - netWorkedHours).toFixed(2))
        : 0;
      let status = "CLEAN";
      if (activeExceptions.length === 0 && resolvedExceptions.length > 0) status = "RESOLVED";
      else if (leave) status = "ON_LEAVE";
      else if (!firstIn || (firstIn && !lastOut)) status = "MISSING_PUNCH";
      else if (unresolvedException) status = "EXCEPTION_FLAGGED";
      else if (overtimeHours > 0) status = "OVERTIME";
      else if (undertimeHours > 0) status = "UNDERTIME";

      return {
        date,
        scheduledShift: shift ? {
          scheduledStart: shift.scheduledStart,
          scheduledEnd: shift.scheduledEnd,
          expectedMinutes: shift.expectedMinutes,
        } : null,
        punches: dayPunches,
        netWorkedHours,
        overtimeHours,
        undertimeHours,
        status,
        exception: unresolvedException ?? null,
      };
    }).filter((row) => statusFilter === "ALL" || row.status === statusFilter);

    const presentRows = rows.filter((row) => row.punches.length > 0).length;
    const leavesTakenDays = leaves.filter((leave) => leave.status === "APPROVED").reduce((sum, leave) => {
      const start = leave.startDate > monthStart ? leave.startDate : monthStart;
      const end = leave.endDate < monthEnd ? leave.endDate : monthEnd;
      const days = Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000) + 1;
      return sum + Math.max(0, days);
    }, 0);
    response.json({
      employee,
      summary: {
        totalDaysLogged: dates.size,
        presentDays: presentRows,
        leavesTakenDays,
        missingPunchCount: rows.filter((row) => row.status === "MISSING_PUNCH").length,
        totalOvertimeHours: Number(rows.reduce((sum, row) => sum + row.overtimeHours, 0).toFixed(2)),
        totalUndertimeHours: Number(rows.reduce((sum, row) => sum + row.undertimeHours, 0).toFixed(2)),
        openExceptionsCount: exceptions.filter((exception) =>
          ["OPEN", "PROPOSED", "ESCALATED"].includes(exception.status),
        ).length,
      },
      dailyActivity: rows,
      leaveRequests: leaves,
    });
  } catch (error) {
    next(error);
  }
});
