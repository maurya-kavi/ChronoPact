export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api").replace(/\/$/, "");

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export interface Employee {
  id: string;
  empCode: string;
  name: string;
  email: string;
  role: string;
  department: string;
  region: "IN" | "US";
  hourlyRate: number;
}

export interface Punch {
  id: string;
  punchType: "IN" | "BREAK_START" | "BREAK_END" | "OUT";
  timestamp: string;
  date: string;
  source: "BIOMETRIC" | "WEB_PORTAL" | "HR_MANUAL";
}

export interface LeaveRequest {
  id: string;
  startDate: string;
  endDate: string;
  leaveType: "SICK" | "CASUAL" | "EARNED";
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
}

export interface Shift {
  id: string;
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  expectedMinutes: number;
  isWeeklyOff: boolean;
}

export interface ExceptionItem {
  id: string;
  employeeId: string;
  date: string;
  anomalyCode: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "PROPOSED" | "APPROVED" | "ESCALATED";
  deterministicDetailsJson: Record<string, unknown>;
  aiProposalJson: TimecardProposal | null;
  guardrailVerified: boolean;
  remainingAnomalies?: Array<{ anomalyCode: string; severity: string }>;
  updatedAt: string;
  employee: Employee;
  punches: Punch[];
  shift: Shift | null;
}

export interface ProposedPunch {
  punchType: "IN" | "BREAK_START" | "BREAK_END" | "OUT";
  isoTimestamp: string;
}

export interface TimecardProposal {
  rootCauseExplanation: string;
  citedPolicyCode: string;
  proposedActionType: string;
  proposedPunches: ProposedPunch[];
  confidenceScore: number;
  employeeMessage?: string;
  guardrailVerified?: boolean;
  remainingAnomalies?: Array<{ anomalyCode: string; severity: string }>;
}

export interface PolicyRule {
  id: string;
  policyCode: string;
  title: string;
  category: "PUNCH" | "OVERTIME" | "BREAK" | "REST_GAP" | "LEAVE" | "SCHEDULE";
  region: "ALL" | "IN" | "US";
  ruleText: string;
  thresholdJson: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  exceptionId: string;
  employeeId: string;
  actionBy: string;
  decision: "APPROVED" | "EDITED_AND_APPROVED" | "ESCALATED";
  beforePunchesJson: Punch[];
  afterPunchesJson: Punch[];
  citedPolicyCode: string;
  notes: string;
  createdAt: string;
  employee: Employee;
  exception: ExceptionItem;
}
