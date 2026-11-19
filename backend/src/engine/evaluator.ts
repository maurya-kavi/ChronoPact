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

const severityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

export function evaluateTimecard(punches: PunchInput[], context: TimecardEvaluationContext): DetectedAnomaly[] {
  const anomalies = [
    ...detectPunchSequenceAnomalies(punches, context.shift),
    ...detectOvertimeRisks(punches, context.shift, context.weeklyWorkedMinutesBeforeToday),
    ...detectScheduleAndLeaveConflicts(punches, context.shift, context.approvedLeaves),
    ...detectLaborPolicyBreaches(punches, context.previousShift?.outTimestamp),
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
): { isSafe: boolean; remainingAnomalies: DetectedAnomaly[] } {
  const remainingAnomalies = evaluateTimecard(proposedPunches, baseContext);
  const materialAnomalies = remainingAnomalies.filter((a) => a.severity === "HIGH" || a.severity === "MEDIUM");
  const isSafe = materialAnomalies.length === 0;
  return { isSafe, remainingAnomalies };
}
