import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { simulateAndVerifyFix, TimecardEvaluationContext } from "../engine/evaluator";
import { LeaveContext, PunchInput, ShiftContext } from "../engine/timeMath";
import { retrieveRelevantPolicies } from "./ragService";

export const TimecardProposalSchema = z.object({
  rootCauseExplanation: z.string().min(20),
  citedPolicyCode: z.string().min(1),
  proposedActionType: z.enum([
    "AUTO_FILL_PUNCH",
    "ADJUST_PUNCH_TIME",
    "FLAG_FOR_OVERTIME_APPROVAL",
    "REQUIRE_EMPLOYEE_CLARIFICATION",
    "REJECT_INVALID_PUNCH",
  ]),
  proposedPunches: z.array(z.object({
    punchType: z.enum(["IN", "BREAK_START", "BREAK_END", "OUT"]),
    isoTimestamp: z.string().datetime(),
  })),
  confidenceScore: z.number().min(0).max(1),
  employeeMessage: z.string().optional(),
  guardrailVerified: z.boolean().optional(),
  remainingAnomalies: z.array(z.object({
    anomalyCode: z.string(),
    severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
    suggestedPolicyCode: z.string().optional(),
    deterministicDetails: z.record(z.unknown()).optional(),
  })).optional(),
});

export type TimecardProposal = z.infer<typeof TimecardProposalSchema>;

function netMinutes(punches: PunchInput[]): number {
  const ins = punches.filter((p) => p.punchType === "IN").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const outs = punches.filter((p) => p.punchType === "OUT").sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (!ins.length || !outs.length) return 0;
  let gross = (outs[0].timestamp.getTime() - ins[0].timestamp.getTime()) / 60000;
  if (gross < 0) gross += 1440;
  return Math.max(0, Math.round(gross));
}

export async function generateExceptionProposal(exceptionId: string): Promise<{
  proposal: TimecardProposal;
  guardrailVerified: boolean;
  remainingAnomalies: unknown[];
}> {
  const exception = await prisma.timecardException.findUnique({
    where: { id: exceptionId },
    include: { employee: true },
  });
  if (!exception) throw new Error("Timecard exception not found");

  const [shift, punchLogs, approvedLeaves, priorShifts] = await Promise.all([
    prisma.shift.findFirst({ where: { employeeId: exception.employeeId, date: exception.date } }),
    prisma.punchLog.findMany({
      where: { employeeId: exception.employeeId, date: exception.date },
      orderBy: { timestamp: "asc" },
    }),
    prisma.leaveRequest.findMany({
      where: { employeeId: exception.employeeId, status: "APPROVED" },
    }),
    prisma.shift.findMany({
      where: { employeeId: exception.employeeId, date: { lt: exception.date } },
      orderBy: { date: "desc" },
      take: 7,
    }),
  ]);
  if (!shift) throw new Error("No scheduled shift found for this exception");

  const punches: PunchInput[] = punchLogs.map((p) => ({
    punchType: p.punchType,
    timestamp: p.timestamp,
    date: p.date,
    source: p.source,
  }));
  const approved: LeaveContext[] = approvedLeaves.map((leave) => ({
    startDate: leave.startDate,
    endDate: leave.endDate,
    status: "APPROVED",
    leaveType: leave.leaveType,
  }));
  const baseShift: ShiftContext = {
    id: shift.id,
    employeeId: shift.employeeId,
    date: shift.date,
    scheduledStart: shift.scheduledStart,
    scheduledEnd: shift.scheduledEnd,
    expectedMinutes: shift.expectedMinutes,
    isWeeklyOff: shift.isWeeklyOff,
  };

  let priorMinutes = 0;
  for (const priorShift of priorShifts) {
    const priorPunches = await prisma.punchLog.findMany({
      where: { employeeId: exception.employeeId, date: priorShift.date },
      orderBy: { timestamp: "asc" },
    });
    priorMinutes += netMinutes(priorPunches.map((p) => ({ punchType: p.punchType, timestamp: p.timestamp })));
  }

  const previousShift = priorShifts.find((item) => item.date < exception.date);
  let previousOut: Date | undefined;
  if (previousShift) {
    previousOut = (await prisma.punchLog.findFirst({
      where: { employeeId: exception.employeeId, date: previousShift.date, punchType: "OUT" },
      orderBy: { timestamp: "desc" },
    }))?.timestamp ?? previousShift.scheduledEnd;
  }

  const baseContext: TimecardEvaluationContext = {
    shift: baseShift,
    approvedLeaves: approved,
    weeklyWorkedMinutesBeforeToday: priorMinutes,
    previousShift: previousOut ? { date: previousShift!.date, outTimestamp: previousOut } : undefined,
  };

  const deterministicDetails = exception.deterministicDetailsJson as Record<string, unknown>;
  const retrieved = await retrieveRelevantPolicies(
    exception.anomalyCode,
    deterministicDetails,
    exception.employee.region,
    3,
  );
  if (!retrieved.length) throw new Error("No matching policy rules were found for this exception");

  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  });

  let lastValidationError: string | undefined;
  let proposal: TimecardProposal | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const policyBlock = retrieved.map((rule) =>
      `${rule.policyCode}: ${rule.title}\n${rule.ruleText}\nthreshold=${JSON.stringify(rule.thresholdJson)}`,
    ).join("\n\n");
    const response = await client.chat.completions.create({
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a governed time and attendance resolution assistant. Ground all claims in deterministic facts and retrieved policies. Never perform time arithmetic or invent exceptions. Return exactly one JSON object. proposedPunches MUST be the complete, chronologically ordered punch sequence for the employee date: preserve every valid existing IN, BREAK_START, BREAK_END, and OUT punch, then add or adjust only the anomalous punch needed. proposedPunches must contain ISO 8601 timestamps. If the corrected total worked duration exceeds 5 hours, include a paired 30-minute meal break (BREAK_START and BREAK_END) unless it already exists. A complete proposal is required for the deterministic post-fix guardrail. citedPolicyCode must exactly match a retrieved policy code.",
        },
        {
          role: "user",
          content: [
            `Exception: ${exception.anomalyCode}`,
            `Deterministic facts: ${JSON.stringify(deterministicDetails)}`,
            `Existing punches: ${JSON.stringify(punches.map((p) => ({ punchType: p.punchType, isoTimestamp: p.timestamp.toISOString() })))}`,
            `Shift: ${JSON.stringify({ scheduledStart: shift.scheduledStart.toISOString(), scheduledEnd: shift.scheduledEnd.toISOString(), date: shift.date })}`,
            "Return proposedPunches as the complete employee-date punch sequence in chronological order, not as a replacement for only the anomalous punch.",
            "Preserve valid existing punches. For durations over 5 hours, ensure a 30-minute BREAK_START/BREAK_END pair exists.",
            exception.anomalyCode === "UNAPPROVED_DAILY_OVERTIME"
              ? "For an UNAPPROVED_DAILY_OVERTIME proposal that makes an automatic correction, reduce the proposed OUT time so net worked duration is at most 9 hours and include a complete punch sequence. Otherwise use FLAG_FOR_OVERTIME_APPROVAL only if the overtime must remain uncorrected."
              : "",
            `Retrieved policies:\n${policyBlock}`,
            lastValidationError ? `Validation error from previous response: ${lastValidationError}` : "",
          ].join("\n\n"),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    try {
      if (!raw) throw new Error("LLM returned an empty response");
      const parsed = TimecardProposalSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(parsed.error.message);
      if (!retrieved.some((rule) => rule.policyCode === parsed.data.citedPolicyCode)) {
        throw new Error(`citedPolicyCode "${parsed.data.citedPolicyCode}" is not in retrieved policy codes`);
      }
      proposal = parsed.data;
      break;
    } catch (error) {
      lastValidationError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!proposal) throw new Error(`LLM proposal failed validation after 3 attempts: ${lastValidationError}`);

  const proposedPunches: PunchInput[] = proposal.proposedPunches.map((p) => ({
    punchType: p.punchType,
    timestamp: new Date(p.isoTimestamp),
  }));
  const simulationResult = simulateAndVerifyFix(proposedPunches, baseContext);

  const metadata: TimecardProposal = {
    ...proposal,
    guardrailVerified: simulationResult.isSafe,
    remainingAnomalies: simulationResult.remainingAnomalies.map((anomaly) => ({
      anomalyCode: anomaly.anomalyCode,
      severity: anomaly.severity,
      suggestedPolicyCode: anomaly.suggestedPolicyCode,
      deterministicDetails: anomaly.deterministicDetails,
    })),
  };
  await prisma.timecardException.update({
    where: { id: exceptionId },
    data: {
      status: "PROPOSED",
      aiProposalJson: metadata as unknown as Prisma.InputJsonObject,
      guardrailVerified: simulationResult.isSafe,
    },
  });

  return {
    proposal,
    guardrailVerified: simulationResult.isSafe,
    remainingAnomalies: simulationResult.remainingAnomalies,
  };
}
