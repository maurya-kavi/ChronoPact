import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  generateExceptionProposal,
  TimecardProposalSchema,
} from "../services/llmHarnessService";

const prisma = new PrismaClient();

interface EvalCase {
  anomalyCode: string;
  expectedPolicyCode: string;
  punchType: "MISSED_OUT" | "NO_BREAK" | "OVERLAP" | "OVERTIME";
}

const cases: EvalCase[] = [
  { anomalyCode: "MISSED_CLOCK_OUT", expectedPolicyCode: "POL-PUNCH-01", punchType: "MISSED_OUT" },
  { anomalyCode: "MISSING_MANDATORY_MEAL_BREAK", expectedPolicyCode: "POL-BRK-01", punchType: "NO_BREAK" },
  { anomalyCode: "INVALID_PUNCH_SEQUENCE", expectedPolicyCode: "POL-PUNCH-02", punchType: "OVERLAP" },
  { anomalyCode: "UNAPPROVED_DAILY_OVERTIME", expectedPolicyCode: "POL-OT-01", punchType: "OVERTIME" },
];

const createdExceptionIds: string[] = [];
const createdEmployeeIds: string[] = [];
let schemaCompliantCases = 0;
let guardrailSafeCases = 0;
let evaluatedCases = 0;

function iso(hour: number, minute = 0, date = "2026-11-19"): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
}

describe("live open-weight LLM evaluation benchmark", () => {
  beforeAll(async () => {
    if (!process.env.GROQ_API_KEY) return;

    await prisma.policyRule.upsert({
      where: { policyCode: "POL-PUNCH-01" },
      create: { policyCode: "POL-PUNCH-01", title: "Missed Clock-Out Verification", category: "PUNCH", region: "ALL", ruleText: "A shift with an IN punch must have a corresponding OUT punch unless HR validates a missed clock-out.", thresholdJson: { missingOut: true } },
      update: { ruleText: "A shift with an IN punch must have a corresponding OUT punch unless HR validates a missed clock-out." },
    });
    await prisma.policyRule.upsert({
      where: { policyCode: "POL-PUNCH-02" },
      create: { policyCode: "POL-PUNCH-02", title: "Open or Unclosed Break Punch", category: "BREAK", region: "ALL", ruleText: "Every BREAK_START punch must be paired with a BREAK_END punch, and punch types must not overlap.", thresholdJson: { pairedBreakRequired: true } },
      update: { ruleText: "Every BREAK_START punch must be paired with a BREAK_END punch, and punch types must not overlap." },
    });
    await prisma.policyRule.upsert({
      where: { policyCode: "POL-BRK-01" },
      create: { policyCode: "POL-BRK-01", title: "Mandatory Meal Break", category: "BREAK", region: "ALL", ruleText: "A continuous work period over 5 hours requires at least a 30-minute meal break.", thresholdJson: { continuousHoursBeforeBreak: 5, minimumBreakMinutes: 30 } },
      update: { ruleText: "A continuous work period over 5 hours requires at least a 30-minute meal break." },
    });
    await prisma.policyRule.upsert({
      where: { policyCode: "POL-OT-01" },
      create: { policyCode: "POL-OT-01", title: "Daily Overtime Approval", category: "OVERTIME", region: "ALL", ruleText: "Daily net work exceeding 9 hours requires approval and must be verified without creating a new violation.", thresholdJson: { dailyHours: 9 } },
      update: { ruleText: "Daily net work exceeding 9 hours requires approval and must be verified without creating a new violation." },
    });
  });

  afterAll(async () => {
    if (createdExceptionIds.length) {
      await prisma.auditLog.deleteMany({ where: { exceptionId: { in: createdExceptionIds } } });
      await prisma.timecardException.deleteMany({ where: { id: { in: createdExceptionIds } } });
    }
    if (createdEmployeeIds.length) {
      await prisma.punchLog.deleteMany({ where: { employeeId: { in: createdEmployeeIds } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: createdEmployeeIds } } });
      await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: createdEmployeeIds } } });
      await prisma.employee.deleteMany({ where: { id: { in: createdEmployeeIds } } });
    }
    await prisma.$disconnect();
  });

  for (const scenario of cases) {
    it(`evaluates ${scenario.anomalyCode}`, async () => {
      if (!process.env.GROQ_API_KEY) {
        console.log(`[LLM Eval SKIPPED] ${scenario.anomalyCode}: GROQ_API_KEY is not set`);
        return;
      }

      const date = "2026-11-19";
      const employee = await prisma.employee.create({
        data: {
          empCode: `EVAL-${Date.now()}-${createdEmployeeIds.length}`,
          name: `LLM Eval ${createdEmployeeIds.length + 1}`,
          email: `llm-eval-${Date.now()}-${createdEmployeeIds.length}@example.com`,
          role: "Evaluator",
          department: "Engineering",
          region: "IN",
          hourlyRate: 30,
        },
      });
      createdEmployeeIds.push(employee.id);

      await prisma.shift.create({
        data: {
          employeeId: employee.id,
          date,
          scheduledStart: iso(9, 0, date),
          scheduledEnd: iso(17, 0, date),
          expectedMinutes: 480,
        },
      });

      let punches: Array<{ punchType: "IN" | "BREAK_START" | "BREAK_END" | "OUT"; timestamp: Date }> =
        [{ punchType: "IN", timestamp: iso(9, 0, date) }, { punchType: "OUT", timestamp: iso(17, 0, date) }];

      if (scenario.punchType === "MISSED_OUT") punches = [{ punchType: "IN", timestamp: iso(9, 0, date) }];
      if (scenario.punchType === "NO_BREAK") {
        punches = [{ punchType: "IN", timestamp: iso(9, 0, date) }, { punchType: "OUT", timestamp: iso(15, 0, date) }];
      }
      if (scenario.punchType === "OVERLAP") {
        punches = [
          { punchType: "IN", timestamp: iso(9, 0, date) },
          { punchType: "IN", timestamp: iso(9, 5, date) },
          { punchType: "OUT", timestamp: iso(17, 0, date) },
        ];
      }
      if (scenario.punchType === "OVERTIME") {
        punches = [
          { punchType: "IN", timestamp: iso(8, 0, date) },
          { punchType: "OUT", timestamp: iso(18, 0, date) },
        ];
      }

      await prisma.punchLog.createMany({
        data: punches.map((punch) => ({
          employeeId: employee.id,
          date,
          punchType: punch.punchType,
          timestamp: punch.timestamp,
          source: "BIOMETRIC" as const,
        })),
      });

      const exception = await prisma.timecardException.create({
        data: {
          employeeId: employee.id,
          date,
          anomalyCode: scenario.anomalyCode,
          severity: scenario.anomalyCode.includes("OVERTIME") ? "MEDIUM" : "HIGH",
          status: "OPEN",
          deterministicDetailsJson: { anomalyCode: scenario.anomalyCode, seededEvaluationCase: true },
        },
      });
      createdExceptionIds.push(exception.id);

      const startedAt = Date.now();
      const result = await generateExceptionProposal(exception.id);
      const latencyMs = Date.now() - startedAt;
      const parsed = TimecardProposalSchema.safeParse(result.proposal);

      evaluatedCases++;
      if (parsed.success) schemaCompliantCases++;
      if (result.guardrailVerified) guardrailSafeCases++;
      expect(parsed.success).toBe(true);
      expect(result.proposal.citedPolicyCode).toBe(scenario.expectedPolicyCode);
      expect(result.guardrailVerified).toBe(true);

      console.log(
        `[LLM Eval] Anomaly=${scenario.anomalyCode} | Expected=${scenario.expectedPolicyCode} | Cited=${result.proposal.citedPolicyCode} | GuardrailSafe=${result.guardrailVerified} | Confidence=${result.proposal.confidenceScore} | Latency=${latencyMs}ms`,
      );
    }, 60_000);
  }

  it("reports aggregate evaluation pass rates", () => {
    if (!process.env.GROQ_API_KEY) {
      console.log("Schema Compliance Rate: SKIPPED (GROQ_API_KEY unavailable)");
      console.log("Guardrail Pass Rate: SKIPPED (GROQ_API_KEY unavailable)");
      return;
    }
    const schemaRate = evaluatedCases ? ((schemaCompliantCases / evaluatedCases) * 100).toFixed(0) : "0";
    const guardrailRate = evaluatedCases ? ((guardrailSafeCases / evaluatedCases) * 100).toFixed(0) : "0";
    console.log(`Schema Compliance Rate: ${schemaRate}%`);
    console.log(`Guardrail Pass Rate: ${guardrailRate}%`);
  });
});
