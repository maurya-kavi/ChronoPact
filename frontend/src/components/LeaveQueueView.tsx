import { useEffect, useState } from "react";
import { api } from "../api";

type QueueLeave = {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string;
  hrNotes?: string;
  hasPunchConflict: boolean;
  hasScheduleOverlap: boolean;
  employee: { empCode: string; name: string; department: string; team?: string };
};

export default function LeaveQueueView() {
  const [status, setStatus] = useState("ALL");
  const [leaves, setLeaves] = useState<QueueLeave[]>([]);
  async function load() {
    setLeaves(await api<QueueLeave[]>(`/leaves?status=${status}`));
  }
  useEffect(() => { void load(); }, [status]);
  async function setLeaveStatus(id: string, nextStatus: "APPROVED" | "REJECTED" | "CANCELLED") {
    await api(`/leaves/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: nextStatus }) });
    await load();
  }
  return (
    <div className="space-y-4"><div className="flex justify-end"><select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>ALL</option><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>CANCELLED</option></select></div><div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Dates</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Conflicts</th><th className="px-4 py-3">Actions</th></tr></thead><tbody>{leaves.map((leave) => (
      <tr key={leave.id} className="border-t border-slate-100"><td className="px-4 py-3"><b>{leave.employee.name}</b><br /><span className="text-xs text-slate-500">{leave.employee.empCode} · {leave.employee.department} · {leave.employee.team}</span></td><td className="px-4 py-3">{leave.startDate} → {leave.endDate}</td><td className="px-4 py-3">{leave.leaveType}</td><td className="px-4 py-3">{leave.status}</td><td className="px-4 py-3">{leave.hasPunchConflict && <span className="mr-1 rounded-full bg-red-100 px-2 py-1 text-xs text-red-700">Punch Conflict</span>} {leave.hasScheduleOverlap && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-700">Schedule Overlap</span>}</td><td className="px-4 py-3"><div className="flex gap-2"><button type="button" onClick={() => void setLeaveStatus(leave.id, "APPROVED")} className="text-xs font-bold text-emerald-700">Approve</button><button type="button" onClick={() => void setLeaveStatus(leave.id, "REJECTED")} className="text-xs font-bold text-amber-700">Reject</button><button type="button" onClick={() => void setLeaveStatus(leave.id, "CANCELLED")} className="text-xs font-bold text-red-700">Cancel</button></div></td></tr>
    ))}</tbody></table></div>
    {leaves.length === 0 && <p className="text-center text-sm text-slate-500">No leave requests found.</p>}</div>
  );
}
