import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type Employee, type LeaveRequest } from "../api";
import ResolutionDrawer from "./ResolutionDrawer";
import { formatIstTime } from "../utils/istTime";

export default function EmployeeProfileDrawer({ employee, onClose, onUpdated }: { employee: Employee; onClose: () => void; onUpdated: () => void }) {
  const [form, setForm] = useState<Employee & { shiftStart?: string; shiftEnd?: string }>({ ...employee });
  const [month, setMonth] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date()));
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [report, setReport] = useState<any>(null);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [selectedExceptionId, setSelectedExceptionId] = useState<string | null>(null);
  const [selectedException, setSelectedException] = useState<any>(null);
  const [message, setMessage] = useState("");

  async function load() {
    setReport(await api<any>(`/employees/${employee.id}/report?month=${month}&statusFilter=${statusFilter}`));
    setLeaves(await api<LeaveRequest[]>(`/leaves?employeeId=${employee.id}`));
  }
  useEffect(() => { void load(); }, [month, statusFilter, employee.id]);

  async function save() {
    try {
      await api(`/employees/${employee.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      setMessage("Employee profile updated.");
      onUpdated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed");
    }
  }

  async function leaveStatus(id: string, status: "APPROVED" | "REJECTED" | "CANCELLED") {
    await api(`/leaves/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    await load();
  }

  async function openException(id: string) {
    setSelectedExceptionId(id);
    setSelectedException(await api<any>(`/exceptions/${id}`));
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/30"><div className="h-full w-full max-w-5xl overflow-y-auto bg-white p-6 shadow-2xl"><div className="flex justify-between"><div><p className="text-xs font-bold uppercase text-teal">Employee 360</p><h2 className="text-xl font-bold text-navy">{employee.name}</h2></div><button type="button" onClick={onClose}><X /></button></div>{message && <p className="mt-3 text-sm text-sky-700">{message}</p>}
      <section className="mt-5 grid gap-3 rounded-xl border border-slate-200 p-5 sm:grid-cols-2"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.team ?? ""} onChange={(event) => setForm({ ...form, team: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.address ?? ""} onChange={(event) => setForm({ ...form, address: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.phone ?? ""} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><select value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value as "IN" | "US" })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>IN</option><option>US</option></select><button type="button" onClick={() => void save()} className="rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white">Save Profile</button></section>
      {report && <section className="mt-5"><div className="flex flex-wrap items-center justify-between gap-3"><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><div className="flex flex-wrap gap-2">{["ALL","MISSING_PUNCH","OVERTIME","UNDERTIME","ON_LEAVE","RESOLVED","CLEAN"].map((status) => <button key={status} type="button" onClick={() => setStatusFilter(status)} className={`rounded-full px-2 py-1 text-xs ${statusFilter === status ? "bg-navy text-white" : "bg-slate-100"}`}>{status}</button>)}</div></div><div className="mt-4 overflow-x-auto rounded-xl border border-slate-200"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3">Date</th><th className="px-3 py-3">Punches (IST)</th><th className="px-3 py-3">Net Hours</th><th className="px-3 py-3">OT</th><th className="px-3 py-3">Undertime</th><th className="px-3 py-3">Status</th><th className="px-3 py-3"></th></tr></thead><tbody>{report.dailyActivity.map((row: any) => { const resolved = row.status === "RESOLVED" || !row.exception || ["APPROVED", "EDITED_AND_APPROVED"].includes(row.exception.status); return <tr key={row.date} className="border-t border-slate-100"><td className="px-3 py-3">{row.date}</td><td className="px-3 py-3">{row.punches.map((punch: any) => `${punch.punchType}@${formatIstTime(punch.timestamp)}`).join(", ") || "-"}</td><td className="px-3 py-3">{row.netWorkedHours}</td><td className="px-3 py-3">{row.overtimeHours}</td><td className="px-3 py-3">{row.undertimeHours}</td><td className="px-3 py-3">{resolved ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700">Resolved</span> : row.status}</td><td className="px-3 py-3">{!resolved && row.exception ? <button type="button" onClick={() => void openException(row.exception.id)} className="text-xs font-bold text-teal">Resolve</button> : ""}</td></tr>; })}</tbody></table></div></section>}
      <section className="mt-5 rounded-xl border border-slate-200 p-5"><h3 className="font-bold text-navy">Leave Requests</h3><div className="mt-3 space-y-2">{leaves.map((leave) => <div key={leave.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-3 text-sm"><div><b>{leave.leaveType}</b> · {leave.startDate} to {leave.endDate} · {leave.status}</div><div className="flex gap-2"><button type="button" onClick={() => void leaveStatus(leave.id, "APPROVED")} className="text-xs font-bold text-emerald-700">Approve</button><button type="button" onClick={() => void leaveStatus(leave.id, "REJECTED")} className="text-xs font-bold text-amber-700">Reject</button><button type="button" onClick={() => void leaveStatus(leave.id, "CANCELLED")} className="text-xs font-bold text-red-700">Cancel</button></div></div>)}</div></section>
    </div>{selectedException && <ResolutionDrawer exception={selectedException} onClose={() => setSelectedException(null)} onResolved={async () => {
      setSelectedException(null);
      await load();
    }} />}</div>
  );
}
