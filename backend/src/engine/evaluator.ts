import {
  detectLaborPolicyBreaches,
  detectOvertimeRisks,
  detectPunchSequenceAnomalies,
  detectScheduleAndLeaveConflicts,
} from "./detectors";
import { DetectedAnomaly, LeaveContext, PunchInput, PreviousShiftContext, ShiftContext } from "./timeMath";

export interface TimecardEvaluationContext {
  shift: ShiftContext;
  approvedLeaves: LeaveContext[];
  weeklyWorkedMinutesBeforeToday: number;
  previousShift?: PreviousShiftContext;
}

export type ActivePolicy = {
  policyCode: string;
  thresholdJson: unknown;
};

export type PolicyConfig = Record<string, Record<string, unknown>>;

export function buildPolicyConfig(activePolicies?: ActivePolicy[]): PolicyConfig | undefined {
  if (!activePolicies) return undefined;
  const config: PolicyConfig = {};
  for (const policy of activePolicies) {
    config[policy.policyCode] =
      typeof policy.thresholdJson === "object" && policy.thresholdJson !== null
        ? policy.thresholdJson as Record<string, unknown>
        : {};
  }
  return config;
}

const severityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

export function evaluateTimecard(
  punches: PunchInput[],
  context: TimecardEvaluationContext,
  activePolicies?: ActivePolicy[],
): DetectedAnomaly[] {
  const policyConfig = buildPolicyConfig(activePolicies);
  const anomalies = [
    ...detectPunchSequenceAnomalies(punches, context.shift, policyConfig),
    ...detectOvertimeRisks(punches, context.shift, context.weeklyWorkedMinutesBeforeToday, policyConfig),
    ...detectScheduleAndLeaveConflicts(punches, context.shift, context.approvedLeaves, policyConfig),
    ...detectLaborPolicyBreaches(punches, context.previousShift?.outTimestamp, policyConfig),
  ];

  const unique = new Map<string, DetectedAnomaly>();
  for (const anomaly of anomalies) {
    if (!unique.has(anomaly.anomalyCode)) unique.set(anomaly.anomalyCode, anomaly);
  }
  return [...unique.values()].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

export function simulateAndVerifyFix(
  proposedPunches: PunchInput[],
  baseContext: TimecardEvaluationContext,
  activePolicies?: ActivePolicy[],
): { isSafe: boolean; remainingAnomalies: DetectedAnomaly[] } {
  const remainingAnomalies = evaluateTimecard(proposedPunches, baseContext, activePolicies);
  const materialAnomalies = remainingAnomalies.filter((a) => a.severity === "HIGH" || a.severity === "MEDIUM");
  const isSafe = materialAnomalies.length === 0;
  return { isSafe, remainingAnomalies };
}
