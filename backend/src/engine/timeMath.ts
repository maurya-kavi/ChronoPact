export type PunchType = "IN" | "BREAK_START" | "BREAK_END" | "OUT";

export interface PunchInput {
  punchType: PunchType;
  timestamp: Date;
  date?: string;
  source?: "BIOMETRIC" | "WEB_PORTAL" | "HR_MANUAL" | "EMPLOYEE" | "HR_APPROVED";
}

export interface ShiftContext {
  id?: string;
  employeeId?: string;
  date: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  expectedMinutes: number;
  isWeeklyOff: boolean;
}

export interface LeaveContext {
  startDate: string;
  endDate: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  leaveType: "SICK" | "CASUAL" | "EARNED";
}

export interface PreviousShiftContext {
  date: string;
  outTimestamp: Date;
}

export interface DetectedAnomaly {
  anomalyCode: string;
  suggestedPolicyCode: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  deterministicDetails: Record<string, unknown>;
}

export function minutesBetween(start: Date, end: Date): number {
  let milliseconds = end.getTime() - start.getTime();
  if (milliseconds < 0) {
    milliseconds += 24 * 60 * 60 * 1000;
  }
  return Math.max(0, Math.round(milliseconds / 60000));
}

export function totalGrossDurationMinutes(punches: PunchInput[]): number {
  const ins = punches.filter((p) => p.punchType === "IN").map((p) => p.timestamp);
  const outs = punches.filter((p) => p.punchType === "OUT").map((p) => p.timestamp);
  if (!ins.length || !outs.length) return 0;
  const firstIn = ins.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  const lastOut = outs.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return minutesBetween(firstIn, lastOut);
}

export function totalBreakMinutes(punches: PunchInput[]): number {
  const starts = punches.filter((p) => p.punchType === "BREAK_START").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ends = punches.filter((p) => p.punchType === "BREAK_END").sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  let total = 0;

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const start = starts[i].timestamp;
    let end = ends[i].timestamp;
    if (end.getTime() < start.getTime()) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }
    total += minutesBetween(start, end);
  }
  return total;
}

export function netWorkedMinutes(punches: PunchInput[]): number {
  return Math.max(0, totalGrossDurationMinutes(punches) - totalBreakMinutes(punches));
}

export function longestContinuousWorkStretchMinutes(punches: PunchInput[]): number {
  const ordered = [...punches].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ins = ordered.filter((p) => p.punchType === "IN");
  const outs = ordered.filter((p) => p.punchType === "OUT");
  if (!ins.length || !outs.length) return 0;

  const firstIn = ins[0].timestamp;
  let lastOut = outs[outs.length - 1].timestamp;
  if (lastOut.getTime() < firstIn.getTime()) {
    lastOut = new Date(lastOut.getTime() + 24 * 60 * 60 * 1000);
  }

  let breakIntervals = ordered
    .filter((p) => p.punchType === "BREAK_START" || p.punchType === "BREAK_END")
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const starts = breakIntervals.filter((p) => p.punchType === "BREAK_START");
  const ends = breakIntervals.filter((p) => p.punchType === "BREAK_END");
  const qualifyingBreakStarts: Date[] = [];

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    let endTime = ends[i].timestamp.getTime();
    if (endTime < starts[i].timestamp.getTime()) endTime += 24 * 60 * 60 * 1000;
    if ((endTime - starts[i].timestamp.getTime()) / 60000 >= 30) {
      qualifyingBreakStarts.push(new Date(starts[i].timestamp.getTime()));
    }
  }

  let stretchStart = firstIn;
  let longest = 0;
  for (const breakStart of qualifyingBreakStarts) {
    let endTime = breakStart.getTime();
    if (endTime < stretchStart.getTime()) endTime += 24 * 60 * 60 * 1000;
    longest = Math.max(longest, Math.round((endTime - stretchStart.getTime()) / 60000));

    const matchingBreakEnd = ends.find((p) => {
      const startIndex = starts.findIndex((s) => s.timestamp.getTime() === breakStart.getTime());
      return startIndex >= 0 && p.timestamp.getTime() >= starts[startIndex].timestamp.getTime();
    });
    if (matchingBreakEnd) {
      let nextStart = matchingBreakEnd.timestamp.getTime();
      if (nextStart < stretchStart.getTime()) nextStart += 24 * 60 * 60 * 1000;
      stretchStart = new Date(nextStart);
    }
  }
  longest = Math.max(longest, Math.round((lastOut.getTime() - stretchStart.getTime()) / 60000));
  return longest;
}

export function restGapHours(previousShiftOutTimestamp: Date, currentShiftInTimestamp: Date): number {
  let gapMilliseconds = currentShiftInTimestamp.getTime() - previousShiftOutTimestamp.getTime();
  if (gapMilliseconds < 0) {
    gapMilliseconds += 24 * 60 * 60 * 1000;
  }
  return gapMilliseconds / (60 * 60 * 1000);
}
