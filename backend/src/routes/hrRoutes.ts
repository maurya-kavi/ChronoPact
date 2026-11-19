import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { runFullTimecardScan } from "../services/scannerService";
import { generateExceptionProposal } from "../services/llmHarnessService";

export const hrRouter = Router();
function withGuardrailMetadata(exception: Record<string, unknown> & { aiProposalJson?: unknown; guardrailVerified: boolean }) {
  const proposal = exception.aiProposalJson && typeof exception.aiProposalJson === "object"
    ? exception.aiProposalJson as Record<string, unknown>
    : null;
  return {
    ...exception,
    guardrailVerified: Boolean(
      typeof proposal?.guardrailVerified === "boolean"
        ? proposal.guardrailVerified
        : exception.guardrailVerified,
    ),
    remainingAnomalies: Array.isArray(proposal?.remainingAnomalies)
      ? proposal.remainingAnomalies
      : [],
  };
}

const resolutionSchema = z.object({
  decision: z.enum(["APPROVED", "EDITED_AND_APPROVED", "ESCALATED"]),
  actionBy: z.string().trim().optional(),
  reviewerName: z.string().trim().optional(),
  citedPolicyCode: z.string().optional(),
  editedPunches: z.array(z.object({
    punchType: z.enum(["IN", "BREAK_START", "BREAK_END", "OUT"]),
    isoTimestamp: z.string().datetime(),
  })).optional(),
  notes: z.string().default(""),
});


hrRouter.get("/api/policies", async (_request, response, next) => {
  try {
    response.json(await prisma.policyRule.findMany({ orderBy: { policyCode: "asc" } }));
  } catch (error) {
    next(error);
  }
});

hrRouter.post("/api/exceptions/scan", async (_request, response, next) => {
  try {
    const result = await runFullTimecardScan();
    response.json({ scanned: result.scanned, flagged: result.createdOrUpdated, createdOrUpdated: result.createdOrUpdated });
  } catch (error) {
    next(error);
  }
});

hrRouter.get("/api/exceptions", async (request, response, next) => {
  try {
    const status = z.enum(["UNRESOLVED", "OPEN", "PROPOSED", "ESCALATED", "APPROVED", "ALL"]).optional().safeParse(request.query.status);
    const severity = z.enum(["HIGH", "MEDIUM", "LOW"]).optional().safeParse(request.query.severity);
    if (!status.success || !severity.success) return response.status(400).json({ error: "Invalid status or severity filter" });
    const date = typeof request.query.date === "string" ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(request.query.date) : undefined;
    const month = typeof request.query.month === "string" ? z.string().regex(/^\d{4}-\d{2}$/).safeParse(request.query.month) : undefined;
    const employeeId = typeof request.query.employeeId === "string" ? request.query.employeeId : undefined;
    if (date && !date.success) return response.status(400).json({ error: "Invalid date filter" });
    if (month && !month.success) return response.status(400).json({ error: "Invalid month filter" });

    const exceptions = await prisma.timecardException.findMany({
      where: {
        ...(status.data === "UNRESOLVED" || !status.data
          ? { status: { in: ["OPEN", "PROPOSED", "ESCALATED"] as const } }
          : status.data === "APPROVED"
            ? { status: { in: ["APPROVED"] as const } }
            : status.data === "ALL"
              ? {}
              : { status: status.data as "OPEN" | "PROPOSED" | "ESCALATED" }),
        ...(severity.data ? { severity: severity.data } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(date?.data ? { date: date.data } : {}),
        ...(month?.data ? { date: { gte: `${month.data}-01`, lte: `${month.data}-31` } } : {}),
      },
      include: { employee: true },
      orderBy: { updatedAt: "desc" },
    });
    const detailed = await Promise.all(exceptions.map(async (exception) => {
      const [punches, shift] = await Promise.all([
        prisma.punchLog.findMany({
          where: { employeeId: exception.employeeId, date: exception.date },
          orderBy: { timestamp: "asc" },
        }),
        prisma.shift.findFirst({ where: { employeeId: exception.employeeId, date: exception.date } }),
      ]);
      return withGuardrailMetadata({ ...exception, punches, shift });
    }));
    detailed.sort((a: any, b: any) => {
      const dateComparison = b.date.localeCompare(a.date);
      if (dateComparison !== 0) return dateComparison;
      const severityRank: Record<"HIGH" | "MEDIUM" | "LOW", number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const aSeverity = String(a.severity) as "HIGH" | "MEDIUM" | "LOW";
      const bSeverity = String(b.severity) as "HIGH" | "MEDIUM" | "LOW";
      return severityRank[aSeverity] - severityRank[bSeverity];
    });
    response.json(detailed);
  } catch (error) {
    next(error);
  }
});

hrRouter.get("/api/exceptions/:id", async (request, response, next) => {
  try {
    const exception = await prisma.timecardException.findUnique({
      where: { id: request.params.id },
      include: { employee: true },
    });
    if (!exception) return response.status(404).json({ error: "Timecard exception not found" });

    const [punches, shift] = await Promise.all([
      prisma.punchLog.findMany({
        where: { employeeId: exception.employeeId, date: exception.date },
        orderBy: { timestamp: "asc" },
      }),
      prisma.shift.findFirst({
        where: { employeeId: exception.employeeId, date: exception.date },
      }),
    ]);
    response.json(withGuardrailMetadata({ ...exception, punches, shift }));
  } catch (error) {
    next(error);
  }
});

hrRouter.post("/api/exceptions/:id/propose", async (request, response, next) => {
  try {
    const result = await generateExceptionProposal(request.params.id);
    const aiProposalJson = {
      ...result.proposal,
      guardrailVerified: result.guardrailVerified,
      remainingAnomalies: result.remainingAnomalies,
    };
    response.status(202).json({
      status: "PROPOSED",
      aiProposalJson,
      guardrailVerified: result.guardrailVerified,
      remainingAnomalies: result.remainingAnomalies,
    });
  } catch (error) {
    next(error);
  }
});

hrRouter.post("/api/exceptions/:id/resolve", async (request, response, next) => {
  try {
    const parsed = resolutionSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid resolution", details: parsed.error.flatten() });
    const reviewerName =
      parsed.data.reviewerName?.trim()
      || parsed.data.actionBy?.trim()
      || "HR Admin";
    const auditNotes = parsed.data.notes ?? "";
    const exception = await prisma.timecardException.findUnique({
      where: { id: request.params.id },
      include: { employee: true },
    });
    if (!exception) return response.status(404).json({ error: "Timecard exception not found" });

    const beforePunches = await prisma.punchLog.findMany({
      where: { employeeId: exception.employeeId, date: exception.date },
      orderBy: { timestamp: "asc" },
    });
      let finalPunches = parsed.data.editedPunches;
      if (!finalPunches?.length && parsed.data.decision !== "ESCALATED") {
        const proposal = exception.aiProposalJson as
          | { proposedPunches?: Array<{ punchType: "IN" | "BREAK_START" | "BREAK_END" | "OUT"; isoTimestamp: string }> }
          | null;
        finalPunches = proposal?.proposedPunches;
      }

      let afterPunches = beforePunches;
      const targetStatus = parsed.data.decision === "ESCALATED" ? "ESCALATED" : "APPROVED";
      if (targetStatus === "APPROVED") {
        const chronological = (finalPunches ?? []).sort((a, b) => a.isoTimestamp.localeCompare(b.isoTimestamp));
        await prisma.punchLog.deleteMany({
          where: { employeeId: exception.employeeId, date: exception.date },
        });
        if (chronological.length) {
          await prisma.punchLog.createMany({
            data: chronological.map((punch) => ({
              employeeId: exception.employeeId,
              date: exception.date,
              punchType: punch.punchType,
              timestamp: new Date(punch.isoTimestamp),
              source: "HR_APPROVED" as const,
            })),
          });
        }
        afterPunches = await prisma.punchLog.findMany({
          where: { employeeId: exception.employeeId, date: exception.date },
          orderBy: { timestamp: "asc" },
        });
      }

      const proposal = exception.aiProposalJson as { citedPolicyCode?: string } | null;
      const citedPolicyCode = parsed.data.citedPolicyCode
        ?? proposal?.citedPolicyCode
        ?? exception.anomalyCode;
      const resolvedAt = new Date();
      const updatedException = await prisma.timecardException.update({
        where: { id: exception.id },
        data: {
          status: targetStatus,
          resolvedBy: reviewerName,
          resolvedAt,
          resolutionNotes: auditNotes,
        },
      });
      if (targetStatus === "APPROVED") {
        await prisma.timecardException.updateMany({
          where: {
            employeeId: exception.employeeId,
            date: exception.date,
            id: { not: exception.id },
            status: { in: ["OPEN", "PROPOSED", "ESCALATED"] },
          },
          data: {
            status: "APPROVED",
            resolvedBy: reviewerName,
            resolvedAt,
            resolutionNotes: auditNotes,
          },
        });
      }
      const auditLog = await prisma.auditLog.create({
        data: {
          exceptionId: exception.id,
          employeeId: exception.employeeId,
          actionBy: reviewerName,
          decision: parsed.data.decision,
          beforePunchesJson: beforePunches as unknown as Prisma.InputJsonValue,
          afterPunchesJson: afterPunches as unknown as Prisma.InputJsonValue,
          citedPolicyCode,
          notes: auditNotes,
        },
      });
      response.status(200).json({ exception: updatedException, auditLog });
  } catch (error) {
    next(error);
  }
});

hrRouter.get("/api/audit-logs", async (_request, response, next) => {
  try {
    response.json(await prisma.auditLog.findMany({
      include: { employee: true, exception: true },
      orderBy: { createdAt: "desc" },
    }));
  } catch (error) {
    next(error);
  }
});
