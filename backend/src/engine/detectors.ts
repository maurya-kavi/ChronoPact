import {
  DetectedAnomaly,
  LeaveContext,
  PunchInput,
  ShiftContext,
  netWorkedMinutes,
  longestContinuousWorkStretchMinutes,
  restGapHours,
  totalBreakMinutes,
} from "./timeMath";

export function detectPunchSequenceAnomalies(punches: PunchInput[], shift: ShiftContext): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [];
  const hasIn = punches.some((p) => p.punchType === "IN");
  const hasOut = punches.some((p) => p.punchType === "OUT");
  if (hasIn && !hasOut) {
    anomalies.push({
      anomalyCode: "MISSED_CLOCK_OUT",
      suggestedPolicyCode: "POL-PUNCH-01",
      severity: "HIGH",
      deterministicDetails: { hasIn: true, hasOut: false, shiftDate: shift.date },
    });
  }

  const starts = punches.filter((p) => p.punchType === "BREAK_START");
  const ends = punches.filter((p) => p.punchType === "BREAK_END");
  if (starts.length > ends.length) {
    anomalies.push({
      anomalyCode: "OPEN_BREAK_PUNCH",
      suggestedPolicyCode: "POL-PUNCH-02",
      severity: "MEDIUM",
      deterministicDetails: { breakStarts: starts.length, breakEnds: ends.length, shiftDate: shift.date },
    });
  }

  const chronologicalInput = punches.every((p, i, all) => i === 0 || all[i - 1].timestamp.getTime() <= p.timestamp.getTime());
  const chronological = [...punches].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let outBeforeIn = false;
  let duplicateConsecutive = false;
  let consecutiveType: PunchInput["punchType"] | undefined;

  for (let i = 0; i < chronological.length; i++) {
    const punch = chronological[i];
    if (punch.punchType === "OUT" && !chronological.slice(0, i).some((p) => p.punchType === "IN")) outBeforeIn = true;
    if (consecutiveType === punch.punchType) duplicateConsecutive = true;
    consecutiveType = punch.punchType;
  }

  if (!chronologicalInput || outBeforeIn || duplicateConsecutive) {
    anomalies.push({
      anomalyCode: "INVALID_PUNCH_SEQUENCE",
      suggestedPolicyCode: "POL-PUNCH-01",
      severity: "HIGH",
      deterministicDetails: {
        outOfChronologicalOrder: !chronologicalInput,
        outBeforeIn,
        duplicateConsecutivePunch: duplicateConsecutive,
      },
    });
  }
  return anomalies;
}

export function detectOvertimeRisks(
  punches: PunchInput[],
  shift: ShiftContext,
  weeklyWorkedMinutesBeforeToday: number,
): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [];
  const todayWorked = netWorkedMinutes(punches);
  if (todayWorked > 540) {
    anomalies.push({
      anomalyCode: "UNAPPROVED_DAILY_OVERTIME",
      suggestedPolicyCode: "POL-OT-01",
      severity: "MEDIUM",
      deterministicDetails: {
        todayNetMinutes: todayWorked,
        thresholdMinutes: 540,
        excessMinutes: todayWorked - 540,
        shiftDate: shift.date,
      },
    });
  }

  const weeklyTotal = weeklyWorkedMinutesBeforeToday + todayWorked;
  if (weeklyTotal > 2400) {
    anomalies.push({
      anomalyCode: "WEEKLY_OVERTIME_THRESHOLD_BREACH",
      suggestedPolicyCode: "POL-OT-02",
      severity: "HIGH",
      deterministicDetails: {
        weeklyTotalMinutes: weeklyTotal,
        thresholdMinutes: 2400,
        weeklyWorkedMinutesBeforeToday,
        todayNetMinutes: todayWorked,
      },
    });
  }
  return anomalies;
}

export function detectScheduleAndLeaveConflicts(
  punches: PunchInput[],
  shift: ShiftContext,
  approvedLeaves: LeaveContext[],
): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [];
  const onApprovedLeave = approvedLeaves.some(
    (leave) => leave.status === "APPROVED" && shift.date >= leave.startDate && shift.date <= leave.endDate,
  );
  if (punches.length > 0 && (onApprovedLeave || shift.isWeeklyOff)) {
    anomalies.push({
      anomalyCode: "PUNCH_ON_APPROVED_LEAVE",
      suggestedPolicyCode: "POL-LV-01",
      severity: "HIGH",
      deterministicDetails: {
        shiftDate: shift.date,
        onApprovedLeave,
        isWeeklyOff: shift.isWeeklyOff,
      },
    });
  }

  const ins = punches.filter((p) => p.punchType === "IN");
  const outs = punches.filter((p) => p.punchType === "OUT");
  if (ins.length || outs.length) {
    const firstIn = ins.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0]?.timestamp;
    const lastOut = outs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]?.timestamp;
    const startDeviation = firstIn ? Math.abs(firstIn.getTime() - shift.scheduledStart.getTime()) / 60000 : 0;
    let endDeviation = 0;
    if (lastOut) {
      endDeviation = Math.abs(lastOut.getTime() - shift.scheduledEnd.getTime()) / 60000;
      if (lastOut.getTime() < shift.scheduledStart.getTime()) endDeviation += 1440;
    }
    if (startDeviation > 120 || endDeviation > 120) {
      anomalies.push({
        anomalyCode: "SHIFT_WINDOW_MISMATCH",
        suggestedPolicyCode: "POL-SCH-01",
        severity: "LOW",
        deterministicDetails: { startDeviationMinutes: Math.round(startDeviation), endDeviationMinutes: Math.round(endDeviation), thresholdMinutes: 120 },
      });
    }
  }
  return anomalies;
}

export function detectLaborPolicyBreaches(
  punches: PunchInput[],
  previousShiftOutTimestamp?: Date,
): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [];
  const continuousMinutes = longestContinuousWorkStretchMinutes(punches);
  const breakMinutes = totalBreakMinutes(punches);
  if (continuousMinutes > 300 && breakMinutes < 30) {
    anomalies.push({
      anomalyCode: "MISSING_MANDATORY_MEAL_BREAK",
      suggestedPolicyCode: "POL-BRK-01",
      severity: "MEDIUM",
      deterministicDetails: {
        longestContinuousMinutes: continuousMinutes,
        breakMinutes,
        thresholdMinutes: 300,
        minimumBreakMinutes: 30,
      },
    });
  }

  const currentIn = [...punches].filter((p) => p.punchType === "IN").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
  if (previousShiftOutTimestamp && currentIn) {
    const gap = restGapHours(previousShiftOutTimestamp, currentIn.timestamp);
    if (gap < 11) {
      anomalies.push({
        anomalyCode: "INSUFFICIENT_REST_GAP",
        suggestedPolicyCode: "POL-RST-01",
        severity: "HIGH",
        deterministicDetails: { gapHours: Number(gap.toFixed(2)), thresholdHours: 11 },
      });
    }
  }
  return anomalies;
}
