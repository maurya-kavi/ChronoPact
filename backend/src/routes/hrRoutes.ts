import { Router } from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { runFullTimecardScan } from "../services/scannerService";
import { ingestPolicyDocument } from "../services/policyIngestionService";
import { generateExceptionProposal } from "../services/llmHarnessService";

export const hrRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

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
  actionBy: z.string().min(1),
  citedPolicyCode: z.string().optional(),
  editedPunches: z.array(z.object({
    punchType: z.enum(["IN", "BREAK_START", "BREAK_END", "OUT"]),
    isoTimestamp: z.string().datetime(),
  })).optional(),
  notes: z.string().default(""),
});

hrRouter.post("/api/policies/upload", upload.single("file"), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: "Policy file is required" });
    const defaultRegion = z.enum(["ALL", "IN", "US"]).parse(request.body.region ?? "ALL");
    const result = await ingestPolicyDocument(request.file.buffer, request.file.originalname, defaultRegion);
    response.status(202).json({
      status: "INGESTED",
      markdownCharacters: result.markdownCharacters,
      extractedRuleCount: result.rules.length,
      rules: result.rules,
    });
  } catch (error) {
    next(error);
  }
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
    const status = z.enum(["OPEN", "PROPOSED", "APPROVED", "ESCALATED"]).optional().safeParse(request.query.status);
    const severity = z.enum(["HIGH", "MEDIUM", "LOW"]).optional().safeParse(request.query.severity);
    if (!status.success || !severity.success) return response.status(400).json({ error: "Invalid status or severity filter" });

    const exceptions = await prisma.timecardException.findMany({
      where: {
        ...(status.data ? { status: status.data } : {}),
        ...(severity.data ? { severity: severity.data } : {}),
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
    const exception = await prisma.timecardException.findUnique({
      where: { id: request.params.id },
      include: { employee: true },
    });
    if (!exception) return response.status(404).json({ error: "Timecard exception not found" });

    const beforePunches = await prisma.punchLog.findMany({
      where: { employeeId: exception.employeeId, date: exception.date },
      orderBy: { timestamp: "asc" },
    });
    let afterPunches = beforePunches;

    if (parsed.data.decision !== "ESCALATED") {
      let editedPunches = parsed.data.editedPunches;
      if (!editedPunches && parsed.data.decision === "APPROVED") {
        const proposal = exception.aiProposalJson as { proposedPunches?: typeof editedPunches } | null;
        editedPunches = proposal?.proposedPunches;
      }
      if (editedPunches?.length) {
        await prisma.punchLog.deleteMany({
          where: { employeeId: exception.employeeId, date: exception.date },
        });
        await prisma.punchLog.createMany({
          data: editedPunches.map((punch) => ({
            employeeId: exception.employeeId,
            date: exception.date,
            punchType: punch.punchType,
            timestamp: new Date(punch.isoTimestamp),
            source: "HR_MANUAL" as const,
          })),
        });
        afterPunches = await prisma.punchLog.findMany({
          where: { employeeId: exception.employeeId, date: exception.date },
          orderBy: { timestamp: "asc" },
        });
      }
    }

    const proposal = exception.aiProposalJson as { citedPolicyCode?: string } | null;
    const citedPolicyCode = parsed.data.citedPolicyCode
      ?? proposal?.citedPolicyCode
      ?? exception.anomalyCode;

    await prisma.auditLog.create({
      data: {
        exceptionId: exception.id,
        employeeId: exception.employeeId,
        actionBy: parsed.data.actionBy,
        decision: parsed.data.decision,
        beforePunchesJson: beforePunches as unknown as Prisma.InputJsonValue,
        afterPunchesJson: afterPunches as unknown as Prisma.InputJsonValue,
        citedPolicyCode,
        notes: parsed.data.notes,
      },
    });
    await prisma.timecardException.update({
      where: { id: exception.id },
      data: {
        status: parsed.data.decision === "ESCALATED" ? "ESCALATED" : "APPROVED",
      },
    });
    response.json({
      status: parsed.data.decision === "ESCALATED" ? "ESCALATED" : "APPROVED",
      decision: parsed.data.decision,
      citedPolicyCode,
    });
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
