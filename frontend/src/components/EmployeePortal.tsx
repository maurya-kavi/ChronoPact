import { useEffect, useState } from "react";
import { CalendarDays, Coffee, Clock3, LogIn, LogOut, Send } from "lucide-react";
import { api, isHrAdminSession, type Employee, type LeaveRequest, type Punch, type Shift } from "../api";
import { formatIstTime } from "../utils/istTime";

type Dashboard = {
  employee: Employee;
  todayShift: Shift | null;
  recentPunches: Punch[];
  leaveRequests: LeaveRequest[];
};

const actions = [
  { type: "IN", label: "Clock In", icon: LogIn },
  { type: "BREAK_START", label: "Start Break", icon: Coffee },
  { type: "BREAK_END", label: "End Break", icon: Send },
  { type: "OUT", label: "Clock Out", icon: LogOut },
] as const;

export default function EmployeePortal({ forcedEmployeeId, isHrPreview = false }: { forcedEmployeeId?: string; isHrPreview?: boolean } = {}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [feedback, setFeedback] = useState("");
  const [flagged, setFlagged] = useState<string[]>([]);
  const [leave, setLeave] = useState({ leaveType: "CASUAL" as "SICK" | "CASUAL" | "EARNED", startDate: "", endDate: "", reason: "" });
  const [month, setMonth] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date()));
  const [attendance, setAttendance] = useState<any>(null);
  const isReadOnlyPreview = isHrPreview || isHrAdminSession();
  const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const todayIst = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;

  useEffect(() => {
    api<Employee[]>("/employees").then((items) => {
      setEmployees(items);
      if (forcedEmployeeId) setEmployeeId(forcedEmployeeId);
      else if (items[0]) setEmployeeId(items[0].id);
    }).catch((error) => setFeedback(error.message));
  }, []);

  useEffect(() => {
    if (employeeId) void refreshDashboard();
  }, [employeeId]);

  useEffect(() => {
    if (!employeeId) return;
    api<any>(`/employees/${employeeId}/report?month=${month}`).then(setAttendance).catch((error) => setFeedback(error.message));
  }, [employeeId, month]);

  async function refreshDashboard() {
    if (!employeeId) return;
    try {
      setDashboard(await api<Dashboard>(`/employees/${employeeId}/dashboard`));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Unable to load dashboard");
    }
  }

  async function punch(type: typeof actions[number]["type"]) {
    if (isReadOnlyPreview) return;
    setFeedback("");
    setFlagged([]);
    try {
      const result = await api<{ status: string; flaggedAnomalies?: string[] }>("/punches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, punchType: type, timestamp: new Date().toISOString(), source: "WEB_PORTAL" }),
      });
      setFeedback(`${type.replace("_", " ")} recorded successfully.`);
      setFlagged(result.flaggedAnomalies ?? []);
      await refreshDashboard();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Punch failed");
    }
  }

  async function submitLeave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isReadOnlyPreview) return;
    setFeedback("");
    if (leave.startDate < todayIst || leave.endDate < leave.startDate) {
      setFeedback("Leave cannot be requested for past dates. Please select today or a future date (IST).");
      return;
    }
    try {
      await api("/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, ...leave }),
      });
      setFeedback("Leave request submitted.");
      setLeave({ leaveType: "CASUAL", startDate: "", endDate: "", reason: "" });
      await refreshDashboard();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Leave request failed");
    }
  }

  const todayPunches = dashboard?.recentPunches.filter((item) => item.date === todayIst).sort((a, b) => a.timestamp.localeCompare(b.timestamp)) ?? [];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-navy">Active Date: {todayIst} - Locked to Today (IST)</div>
      {feedback && <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">{feedback}</div>}
      {flagged.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
          Exception flagged for HR review: {flagged.join(", ")}
        </div>
      )}

      <section className={`grid gap-6 ${isReadOnlyPreview ? "grid-cols-1" : "xl:grid-cols-[1fr_1fr]"}`}>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500" htmlFor="employee">Employee profile</label>
          <select id="employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 text-sm">
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.empCode} - {employee.name} - {employee.role} - {employee.department} - {employee.region}</option>
            ))}
          </select>
          {dashboard?.employee && (
            <div className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
              <div><span className="text-slate-500">Employee ID</span><p className="font-bold">{dashboard.employee.empCode}</p></div>
              <div><span className="text-slate-500">Full Name</span><p className="font-bold">{dashboard.employee.name}</p></div>
              <div><span className="text-slate-500">Role</span><p className="font-bold">{dashboard.employee.role}</p></div>
              <div><span className="text-slate-500">Department</span><p className="font-bold">{dashboard.employee.department}</p></div>
              <div><span className="text-slate-500">Team</span><p className="font-bold">{dashboard.employee.team ?? "Core Operations"}</p></div>
              <div><span className="text-slate-500">Region</span><p className="font-bold">{dashboard.employee.region}</p></div>
              <div><span className="text-slate-500">Email</span><p className="font-bold">{dashboard.employee.email}</p></div>
              <div><span className="text-slate-500">Phone</span><p className="font-bold">{dashboard.employee.phone ?? "Not Provided"}</p></div>
              <div className="sm:col-span-2"><span className="text-slate-500">Address</span><p className="font-bold">{dashboard.employee.address ?? "Not Provided"}</p></div>
              <div className="sm:col-span-2"><span className="inline-block rounded-full border border-slate-300 px-2 py-1 text-xs font-bold text-slate-600">Managed by HR (Read-Only)</span></div>
            </div>
          )}
          {dashboard?.todayShift && (
            <div className="mt-5 rounded-xl bg-navy p-5 text-white">
              <p className="text-sm text-slate-300">Today’s shift</p>
              <p className="mt-2 text-2xl font-bold">{formatIstTime(dashboard.todayShift.scheduledStart)} - {formatIstTime(dashboard.todayShift.scheduledEnd)}</p>
              <p className="mt-2 text-sm">{dashboard.todayShift.expectedMinutes / 60} expected hours · {dashboard.todayShift.isWeeklyOff ? "Weekly off" : "Compliant schedule"}</p>
            </div>
          )}
        </div>

        {!isReadOnlyPreview && <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="font-bold text-navy">Live Action Punch Pad</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {actions.map(({ type, label, icon: Icon }) => (
              <button key={type} type="button" disabled={!employeeId} onClick={() => void punch(type)} className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-4 text-sm font-bold text-navy transition hover:border-teal hover:bg-teal/5 disabled:opacity-50">
                <Icon size={18} /> {label}
              </button>
            ))}
          </div>
        </div>}
      </section>

      {attendance && (
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="font-bold text-navy">Monthly Attendance and Compliance Report</h2><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>
          <div className="grid gap-3 md:grid-cols-5">
            {[
              ["Present Days", attendance.summary.presentDays],
              ["Leaves Taken", attendance.summary.leavesTakenDays],
              ["Missing Punches", attendance.summary.missingPunchCount],
              ["Overtime Hours", attendance.summary.totalOvertimeHours],
              ["Undertime Hours", attendance.summary.totalUndertimeHours],
            ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">{String(label)}</p><p className="mt-2 text-2xl font-bold text-navy">{String(value)}</p></div>)}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Shift (IST)</th><th className="px-4 py-3">Punches (IST)</th><th className="px-4 py-3">Worked</th><th className="px-4 py-3">OT / Undertime</th><th className="px-4 py-3">Status</th></tr></thead><tbody>{attendance.dailyActivity.map((row: any) => <tr key={row.date} className="border-t border-slate-100"><td className="px-4 py-3">{row.date}</td><td className="px-4 py-3">{row.scheduledShift ? `${formatIstTime(row.scheduledShift.scheduledStart)} - ${formatIstTime(row.scheduledShift.scheduledEnd)}` : "No scheduled shift"}</td><td className="px-4 py-3">{row.punches.map((punch: Punch) => `${punch.punchType}@${formatIstTime(punch.timestamp)}`).join(", ") || "-"}</td><td className="px-4 py-3">{row.netWorkedHours}h</td><td className="px-4 py-3">{row.overtimeHours}h / {row.undertimeHours}h</td><td className="px-4 py-3">{row.status === "RESOLVED" || !row.exception || ["APPROVED", "EDITED_AND_APPROVED"].includes(row.exception.status) ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700">Resolved</span> : <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold">{row.status}</span>}</td></tr>)}</tbody></table></div>
        </section>
      )}

      <section className={`grid gap-6 ${isReadOnlyPreview ? "grid-cols-1" : "xl:grid-cols-[1fr_1fr]"}`}>
        {!isReadOnlyPreview && <form onSubmit={submitLeave} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="flex items-center gap-2 font-bold text-navy"><CalendarDays size={18} /> Request Leave</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <select value={leave.leaveType} onChange={(event) => setLeave({ ...leave, leaveType: event.target.value as typeof leave.leaveType })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option>SICK</option><option>CASUAL</option><option>EARNED</option>
            </select>
            <input type="date" required min={todayIst} value={leave.startDate} onChange={(event) => setLeave({ ...leave, startDate: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input type="date" required min={leave.startDate || todayIst} value={leave.endDate} onChange={(event) => setLeave({ ...leave, endDate: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input type="text" required placeholder="Reason" value={leave.reason} onChange={(event) => setLeave({ ...leave, reason: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={!employeeId} className="mt-4 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white">Submit Leave</button>
        </form>}

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="flex items-center gap-2 font-bold text-navy"><Clock3 size={18} /> Daily Activity Log</h2>
          <div className="mt-4 space-y-2">
            {todayPunches.map((item) => (
              <div key={item.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"><span className="font-semibold">{item.punchType}</span><span>{formatIstTime(item.timestamp)}</span></div>
            ))}
            {todayPunches.length === 0 && <p className="text-sm text-slate-500">No punches recorded today.</p>}
          </div>
          <h3 className="mt-5 text-xs font-bold uppercase text-slate-500">Leave History</h3>
            <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Dates</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Status</th></tr></thead><tbody>{dashboard?.leaveRequests.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="py-2 pr-3">{item.startDate} – {item.endDate}</td><td className="py-2 pr-3">{item.leaveType}</td><td className="py-2 pr-3 font-semibold">{item.status}</td></tr>)}</tbody></table></div>
        </div>
      </section>
    </div>
  );
}
