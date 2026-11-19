import { describe, expect, it } from "vitest";
import {
  longestContinuousWorkStretchMinutes,
  netWorkedMinutes,
  restGapHours,
  totalBreakMinutes,
  totalGrossDurationMinutes,
  type PunchInput,
  type ShiftContext,
  type LeaveContext,
} from "../src/engine/timeMath";
import {
  detectLaborPolicyBreaches,
  detectOvertimeRisks,
  detectPunchSequenceAnomalies,
  detectScheduleAndLeaveConflicts,
} from "../src/engine/detectors";
import { evaluateTimecard, simulateAndVerifyFix } from "../src/engine/evaluator";

const date = "2026-11-13";
const dt = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const shift = (scheduledStart = dt(date, 9), scheduledEnd = dt(date, 17)): ShiftContext => ({
  date,
  scheduledStart,
  scheduledEnd,
  expectedMinutes: 480,
  isWeeklyOff: false,
});
const punch = (punchType: PunchInput["punchType"], hour: number, minute = 0, day = date): PunchInput => ({
  punchType,
  timestamp: dt(day, hour, minute),
});
const validShiftPunches = (): PunchInput[] => [
  punch("IN", 9),
  punch("BREAK_START", 13),
  punch("BREAK_END", 13, 30),
  punch("OUT", 17, 30),
];
const context = (overrides: Partial<Parameters<typeof evaluateTimecard>[1]> = {}) => ({
  shift: shift(),
  approvedLeaves: [] as LeaveContext[],
  weeklyWorkedMinutesBeforeToday: 0,
  ...overrides,
});

describe("time math", () => {
  it("calculates gross, break, and net time for a valid 8.5-hour shift", () => {
    const punches = validShiftPunches();
    expect(totalGrossDurationMinutes(punches)).toBe(510);
    expect(totalBreakMinutes(punches)).toBe(30);
    expect(netWorkedMinutes(punches)).toBe(480);
  });

  it("calculates longest continuous stretch across a 30-minute break", () => {
    expect(longestContinuousWorkStretchMinutes(validShiftPunches())).toBe(240);
  });

  it("calculates cross-midnight gross duration accurately", () => {
    const punches = [punch("IN", 22, 0, "2026-11-13"), punch("OUT", 6, 0, "2026-11-14")];
    expect(totalGrossDurationMinutes(punches)).toBe(480);
  });

  it("calculates rest gap across consecutive shifts accurately", () => {
    expect(restGapHours(dt("2026-11-13", 17), dt("2026-11-14", 4, 30))).toBe(11.5);
  });
});

describe("deterministic anomaly detectors", () => {
  it("accepts a clean valid 8.5-hour shift with a meal break", () => {
    expect(evaluateTimecard(validShiftPunches(), context())).toEqual([]);
  });

  it("accepts exactly 9 worked hours", () => {
    const punches = [punch("IN", 8), punch("BREAK_START", 12), punch("BREAK_END", 12, 30), punch("OUT", 17, 30)];
    expect(detectOvertimeRisks(punches, shift(), 0).map((a) => a.anomalyCode)).not.toContain("UNAPPROVED_DAILY_OVERTIME");
  });

  it("flags 9 hours 15 minutes worked", () => {
    const punches = [punch("IN", 8), punch("BREAK_START", 12), punch("BREAK_END", 12, 30), punch("OUT", 17, 45)];
    const overtime = detectOvertimeRisks(punches, shift(), 0);
    expect(overtime).toContainEqual(expect.objectContaining({
      anomalyCode: "UNAPPROVED_DAILY_OVERTIME",
      deterministicDetails: expect.objectContaining({ excessMinutes: 15 }),
    }));
  });

  it("flags weekly overtime for 38 prior hours plus 4 today", () => {
    const overtime = detectOvertimeRisks(validShiftPunches(), shift(), 2280);
    expect(overtime).toContainEqual(expect.objectContaining({
      anomalyCode: "WEEKLY_OVERTIME_THRESHOLD_BREACH",
      deterministicDetails: expect.objectContaining({ weeklyTotalMinutes: 2760 }),
    }));
  });

  it("allows exactly 40 weekly hours", () => {
    expect(detectOvertimeRisks(validShiftPunches(), shift(), 1920).map((a) => a.anomalyCode)).not.toContain("WEEKLY_OVERTIME_THRESHOLD_BREACH");
  });

  it("flags a missed clock-out", () => {
    const anomalies = detectPunchSequenceAnomalies([punch("IN", 9)], shift());
    expect(anomalies.map((a) => a.anomalyCode)).toContain("MISSED_CLOCK_OUT");
  });

  it("flags an unclosed break punch", () => {
    const anomalies = detectPunchSequenceAnomalies([punch("IN", 9), punch("BREAK_START", 13), punch("OUT", 17)], shift());
    expect(anomalies.map((a) => a.anomalyCode)).toContain("OPEN_BREAK_PUNCH");
  });

  it("flags out-of-order punch sequence", () => {
    const anomalies = detectPunchSequenceAnomalies([punch("OUT", 17), punch("IN", 9)], shift());
    expect(anomalies.map((a) => a.anomalyCode)).toContain("INVALID_PUNCH_SEQUENCE");
  });

  it("flags duplicate consecutive punches", () => {
    const anomalies = detectPunchSequenceAnomalies([punch("IN", 9), punch("IN", 9, 5), punch("OUT", 17)], shift());
    expect(anomalies.map((a) => a.anomalyCode)).toContain("INVALID_PUNCH_SEQUENCE");
  });

  it("flags a continuous 6-hour shift without a meal break", () => {
    const anomalies = detectLaborPolicyBreaches([punch("IN", 9), punch("OUT", 15)]);
    expect(anomalies.map((a) => a.anomalyCode)).toContain("MISSING_MANDATORY_MEAL_BREAK");
  });

  it("accepts a rest gap of 11.5 hours", () => {
    expect(detectLaborPolicyBreaches([punch("IN", 4, 30)], dt("2026-11-13", 17)).map((a) => a.anomalyCode)).not.toContain("INSUFFICIENT_REST_GAP");
  });

  it("flags a rest gap of 9.5 hours with exact gap details", () => {
    const anomalies = detectLaborPolicyBreaches([punch("IN", 2, 30)], dt("2026-11-13", 17));
    expect(anomalies).toContainEqual(expect.objectContaining({
      anomalyCode: "INSUFFICIENT_REST_GAP",
      deterministicDetails: expect.objectContaining({ gapHours: 9.5 }),
    }));
  });

  it("flags punch logged on an approved leave date", () => {
    const leaves: LeaveContext[] = [{ startDate: date, endDate: date, status: "APPROVED", leaveType: "SICK" }];
    const anomalies = detectScheduleAndLeaveConflicts(validShiftPunches(), shift(), leaves);
    expect(anomalies.map((a) => a.anomalyCode)).toContain("PUNCH_ON_APPROVED_LEAVE");
  });

  it("flags shift variance greater than 2 hours", () => {
    const punches = [punch("IN", 5), punch("OUT", 17)];
    const anomalies = detectScheduleAndLeaveConflicts(punches, shift(), []);
    expect(anomalies.map((a) => a.anomalyCode)).toContain("SHIFT_WINDOW_MISMATCH");
  });

  it("allows exactly 2 hours shift variance", () => {
    const punches = [punch("IN", 7), punch("OUT", 19)];
    expect(detectScheduleAndLeaveConflicts(punches, shift(), []).map((a) => a.anomalyCode)).not.toContain("SHIFT_WINDOW_MISMATCH");
  });

  it("sorts master evaluation anomalies with HIGH first", () => {
    const punches = [punch("IN", 7)];
    const anomalies = evaluateTimecard(punches, context());
    expect(anomalies[0]?.severity).toBe("HIGH");
  });

  it("post-fix simulator accepts a valid missing clock-out repair", () => {
    const base = context();
    const result = simulateAndVerifyFix([punch("IN", 9), punch("BREAK_START", 13), punch("BREAK_END", 13, 30), punch("OUT", 17)], base);
    expect(result.isSafe).toBe(true);
    expect(result.remainingAnomalies).toEqual([]);
  });

  it("post-fix simulator rejects an unsafe late clock-out without a break", () => {
    const base = context();
    const result = simulateAndVerifyFix([punch("IN", 9), punch("OUT", 21)], base);
    expect(result.isSafe).toBe(false);
    expect(result.remainingAnomalies.map((a) => a.anomalyCode)).toContain("UNAPPROVED_DAILY_OVERTIME");
  });

  it("post-fix simulator rejects a fix that creates an insufficient rest gap", () => {
    const base = context({
      previousShift: { date: "2026-11-12", outTimestamp: dt("2026-11-12", 20) },
    });
    const result = simulateAndVerifyFix([punch("IN", 5, 30), punch("OUT", 17)], base);
    expect(result.isSafe).toBe(false);
    expect(result.remainingAnomalies.map((a) => a.anomalyCode)).toContain("INSUFFICIENT_REST_GAP");
  });
});
