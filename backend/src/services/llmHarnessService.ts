import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { simulateAndVerifyFix, TimecardEvaluationContext } from "../engine/evaluator";
import { LeaveContext, PunchInput, ShiftContext } from "../engine/timeMath";
import { retrieveRelevantPoliciesAndChunks } from "./ragService";

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
  modelUsed: z.string().optional(),
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

function normalizeProposalResponse(
  parsedJson: unknown,
  existingPunches: PunchInput[],
  suggestedPolicyCode: string,
): unknown {
  let raw: Record<string, unknown> =
    parsedJson && typeof parsedJson === "object"
      ? parsedJson as Record<string, unknown>
      : {};
  if (raw.proposal && typeof raw.proposal === "object") {
    raw = raw.proposal as Record<string, unknown>;
  } else if (raw.data && typeof raw.data === "object") {
    raw = raw.data as Record<string, unknown>;
  }

  const rootCauseExplanation =
    raw.rootCauseExplanation ?? raw.root_cause_explanation ?? raw.explanation;
  const citedPolicyCode =
    raw.citedPolicyCode ?? raw.cited_policy_code ?? raw.policyCode ?? suggestedPolicyCode;
  const proposedActionType =
    raw.proposedActionType ?? raw.proposed_action_type ?? raw.actionType;
  const proposedPunches = Array.isArray(raw.proposedPunches)
    ? raw.proposedPunches
    : existingPunches.map((punch) => ({
        punchType: punch.punchType,
        isoTimestamp: punch.timestamp.toISOString(),
      }));
  const confidenceValue =
    typeof raw.confidenceScore === "number"
      ? raw.confidenceScore
      : typeof raw.confidence === "number"
        ? raw.confidence
        : 0.85;

  return {
    rootCauseExplanation:
      typeof rootCauseExplanation === "string" && rootCauseExplanation.trim()
        ? rootCauseExplanation.trim()
        : undefined,
    citedPolicyCode:
      typeof citedPolicyCode === "string" ? citedPolicyCode : suggestedPolicyCode,
    proposedActionType,
    proposedPunches,
    confidenceScore: Number(confidenceValue),
  };
}

function netMinutes(punches: PunchInput[]): number {
  const ins = punches.filter((p) => p.punchType === "IN").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const outs = punches.filter((p) => p.punchType === "OUT").sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (!ins.length || !outs.length) return 0;
  let gross = (outs[0].timestamp.getTime() - ins[0].timestamp.getTime()) / 60000;
  if (gross < 0) gross += 1440;
  return Math.max(0, Math.round(gross));
}

function formatIst(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(date) + " IST";
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

  const [shift, punchLogs, approvedLeaves, priorShifts, dayExceptions] = await Promise.all([
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
    prisma.timecardException.findMany({
      where: { employeeId: exception.employeeId, date: exception.date, status: { in: ["OPEN", "PROPOSED", "ESCALATED"] } },
      select: { anomalyCode: true },
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
  const activePolicies = await prisma.policyRule.findMany({
    select: { policyCode: true, thresholdJson: true },
  });
  const retrievedContext = await retrieveRelevantPoliciesAndChunks({
    anomalyCode: exception.anomalyCode,
    region: exception.employee.region,
    employeeTeam: exception.employee.team,
    employeeDepartment: exception.employee.department,
    shiftStart: shift.scheduledStart.toISOString(),
    shiftEnd: shift.scheduledEnd.toISOString(),
    rawDetails: deterministicDetails,
  });
  const retrieved = retrievedContext.rules;
  if (!retrieved.length && !retrievedContext.chunks.length) throw new Error("No matching policies or policy passages were found for this exception");

  const suggestedPolicyCode =
    exception.anomalyCode.includes("OVERTIME") ? "POL-OT-01"
      : exception.anomalyCode.includes("BREAK") ? "POL-BRK-01"
      : exception.anomalyCode.includes("REST") ? "POL-RST-01"
      : exception.anomalyCode.includes("LEAVE") ? "POL-LV-01"
      : exception.anomalyCode.includes("SHIFT") || exception.anomalyCode.includes("SCHEDULE") ? "POL-SCH-01"
      : exception.anomalyCode.includes("PUNCH") || exception.anomalyCode.includes("CLOCK") ? "POL-PUNCH-01"
      : "";
  const orderedRules = [
    ...retrieved.filter((rule) => rule.policyCode === suggestedPolicyCode),
    ...retrieved.filter((rule) => rule.policyCode !== suggestedPolicyCode),
  ].slice(0, 4);

  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  });

  let lastValidationError: string | undefined;
  let proposal: TimecardProposal | undefined;
  let verifiedSimulation: ReturnType<typeof simulateAndVerifyFix> | undefined;
  let modelUsed = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  const fallbackModel = process.env.LLM_EVAL_MODEL || "openai/gpt-oss-20b";
  const exactJsonContract = [
    "Return ONLY a valid JSON object with these exact 5 top-level keys:",
    "- rootCauseExplanation: non-empty string explaining the anomaly and policy rule.",
    "- citedPolicyCode: exact policy code such as POL-OT-01 or POL-PUNCH-01.",
    "- proposedActionType: exactly one of AUTO_FILL_PUNCH, ADJUST_PUNCH_TIME, FLAG_FOR_OVERTIME_APPROVAL, REQUIRE_EMPLOYEE_CLARIFICATION, REJECT_INVALID_PUNCH.",
    "- proposedPunches: array of objects with punchType IN, BREAK_START, BREAK_END, or OUT and isoTimestamp ISO-8601 UTC; include the complete chronological shift-date list.",
    "- confidenceScore: number between 0 and 1.",
  ].join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const policyBlock = orderedRules.map((rule) =>
      `${rule.policyCode}: ${rule.title}\n${rule.ruleText.slice(0, 300)}`,
    ).join("\n\n");
    const chunkBlock = retrievedContext.chunks.slice(0, 3).map((chunk) =>
      `PASSAGE [${chunk.sectionTitle.slice(0, 40)}]: ${chunk.chunkText.slice(0, 750)}`,
    ).join("\n\n");
    let response;
    try {
      response = await client.chat.completions.create({
        model: modelUsed,
        temperature: 0,
        response_format: { type: "json_object" },
        max_completion_tokens: 2048,
        messages: [
        {
          role: "system",
          content: `${exactJsonContract}\nFor UNAPPROVED_DAILY_OVERTIME when punches are valid and approval is needed, preserve existing punches and use FLAG_FOR_OVERTIME_APPROVAL. For PUNCH_ON_APPROVED_LEAVE, use REJECT_INVALID_PUNCH with proposedPunches exactly []. For SHIFT_WINDOW_MISMATCH, MISSED_CLOCK_OUT, MISSING_MANDATORY_MEAL_BREAK, or OPEN_BREAK_PUNCH, return a complete valid full-day sequence aligned to the assigned shift start and end and include a 30-minute BREAK_START/BREAK_END pair if duration exceeds 5 hours. Never calculate time or invent facts.`,
        },
        {
          role: "user",
          content: [
            `Exception: ${exception.anomalyCode}`,
            `All active anomalies on this date: ${dayExceptions.map((item) => item.anomalyCode).join(", ")}`,
            `Deterministic facts: ${JSON.stringify(deterministicDetails)}`,
            `Existing punches: ${JSON.stringify(punches.map((p) => ({ punchType: p.punchType, isoTimestamp: p.timestamp.toISOString() })))}`,
            `Shift: ${JSON.stringify({ scheduledStartUtc: shift.scheduledStart.toISOString(), scheduledStartIst: formatIst(shift.scheduledStart), scheduledEndUtc: shift.scheduledEnd.toISOString(), scheduledEndIst: formatIst(shift.scheduledEnd), date: shift.date })}`,
            `Employee context: ${JSON.stringify({ empCode: exception.employee.empCode, name: exception.employee.name, department: exception.employee.department, team: exception.employee.team, role: exception.employee.role, region: exception.employee.region, shiftStartUtc: shift.scheduledStart.toISOString(), shiftStartIst: formatIst(shift.scheduledStart), shiftEndUtc: shift.scheduledEnd.toISOString(), shiftEndIst: formatIst(shift.scheduledEnd) })}`,
            dayExceptions.some((item) => item.anomalyCode === "PUNCH_ON_APPROVED_LEAVE")
              ? "PUNCH_ON_APPROVED_LEAVE is present: set proposedActionType to REJECT_INVALID_PUNCH, proposedPunches to exactly [], and explain punches on approved leave must be voided or HR must cancel the leave first."
              : "",
            "Return proposedPunches as the complete employee-date punch sequence in chronological order, not as a replacement for only the anomalous punch.",
            "Preserve valid existing punches. For durations over 5 hours, ensure a 30-minute BREAK_START/BREAK_END pair exists.",
            exception.anomalyCode === "UNAPPROVED_DAILY_OVERTIME"
              ? "For an UNAPPROVED_DAILY_OVERTIME proposal that makes an automatic correction, reduce the proposed OUT time so net worked duration is at most 9 hours and include a complete punch sequence. Otherwise use FLAG_FOR_OVERTIME_APPROVAL only if the overtime must remain uncorrected."
              : "",
            `Retrieved policies:\n${policyBlock}`,
            `Retrieved policy chunks:\n${chunkBlock}`,
            lastValidationError
              ? `Retry ${attempt + 1}: Exact Zod validation error from the previous response: ${lastValidationError}. Correct every invalid or missing field and return valid JSON.`
              : "",
          ].join("\n\n"),
        },
        ],
      });
    } catch (error) {
      const err = error as { status?: number; error?: { message?: string }; message?: string };
      const isRateLimit = err.status === 429
        || /429|rate limit|tpm/i.test(err.error?.message ?? err.message ?? "");
      if (isRateLimit) {
        console.warn(`Groq 429/TPM rate limit on ${modelUsed}; waiting 2000ms and switching to ${fallbackModel}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        modelUsed = fallbackModel;
        try {
          response = await client.chat.completions.create({
            model: fallbackModel,
            temperature: 0,
            response_format: { type: "json_object" },
            max_completion_tokens: 2048,
            messages: [
              { role: "system", content: `${exactJsonContract}\nNever calculate time or invent facts. Preserve existing punches for approval-only overtime.` },
              { role: "user", content: `Return JSON now.\nException=${exception.anomalyCode}\nActive date anomalies=${dayExceptions.map((item) => item.anomalyCode).join(", ")}\nEmployee=${exception.employee.empCode},${exception.employee.team},${exception.employee.department}\nShift UTC=${shift.scheduledStart.toISOString()}-${shift.scheduledEnd.toISOString()}\nShift IST=${formatIst(shift.scheduledStart)}-${formatIst(shift.scheduledEnd)}\n${dayExceptions.some((item) => item.anomalyCode === "PUNCH_ON_APPROVED_LEAVE") ? "PUNCH_ON_APPROVED_LEAVE requires REJECT_INVALID_PUNCH with proposedPunches=[] and an explanation that HR must void the punches or cancel leave first.\n" : ""}For shift mismatch, missed clock out, mandatory break, or open break anomalies, return a complete aligned full-day sequence and include a 30-minute break pair when shift duration exceeds 5 hours.\nPunches=${JSON.stringify(punches.map((p) => ({ punchType: p.punchType, isoTimestamp: p.timestamp.toISOString() })))}\nPolicies=${policyBlock}\nChunks=${chunkBlock}${lastValidationError ? `\nExact Zod validation or guardrail remainingAnomalies codes: ${lastValidationError}` : ""}` },
            ],
          });
        } catch (fallbackError) {
          lastValidationError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          continue;
        }
      } else {
        throw error;
      }
    }
    if (!response) throw new Error("Groq returned no completion response");
    const raw = response.choices[0]?.message?.content;
    try {
      if (!raw) throw new Error("LLM returned an empty response");
      const parsedJson = JSON.parse(raw);
      const normalized = normalizeProposalResponse(parsedJson, punches, suggestedPolicyCode);
      const parsed = TimecardProposalSchema.safeParse(normalized);
      if (!parsed.success) throw new Error(parsed.error.message);
      if (!orderedRules.some((rule) => rule.policyCode === parsed.data.citedPolicyCode)) {
        throw new Error(`citedPolicyCode "${parsed.data.citedPolicyCode}" is not in retrieved policy codes`);
      }
      const candidatePunches = parsed.data.proposedPunches.map((p) => ({ punchType: p.punchType, timestamp: new Date(p.isoTimestamp) }));
      const simulation = simulateAndVerifyFix(candidatePunches, baseContext, activePolicies, parsed.data.proposedActionType);
      if (!simulation.isSafe) {
        const codes = simulation.remainingAnomalies.map((item) => item.anomalyCode);
        lastValidationError = `Guardrail remainingAnomalies codes: ${codes.join(", ")}`;
        if (attempt < 2) continue;
        verifiedSimulation = simulation;
        proposal = { ...parsed.data, modelUsed };
        break;
      }
      verifiedSimulation = simulation;
      proposal = { ...parsed.data, modelUsed };
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
  const simulationResult = verifiedSimulation ?? simulateAndVerifyFix(proposedPunches, baseContext, activePolicies, proposal.proposedActionType);

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
