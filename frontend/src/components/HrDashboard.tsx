import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardCheck, FileCheck2, Plus, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { api, type AuditRecord, type Employee, type ExceptionItem } from "../api";
import ResolutionDrawer from "./ResolutionDrawer";
import PolicyManager from "./PolicyManager";
import AuditLogView from "./AuditLogView";
import EmployeeDirectory from "./EmployeeDirectory";
import LeaveQueueView from "./LeaveQueueView";

type Tab = "queue" | "employees" | "leaves" | "policies" | "audit";

export default function HrDashboard() {
  const [tab, setTab] = useState<Tab>("queue");
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [status, setStatus] = useState("UNRESOLVED");
  const [severity, setSeverity] = useState("ALL");
  const [dateFilter, setDateFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [selected, setSelected] = useState<ExceptionItem | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (status !== "ALL") params.set("status", status);
    if (severity !== "ALL") params.set("severity", severity);
    if (dateFilter) params.set("date", dateFilter);
    if (monthFilter) params.set("month", monthFilter);
    try {
      setExceptions(await api<ExceptionItem[]>(`/exceptions${params.size ? `?${params}` : ""}`));
      setAudits(await api<AuditRecord[]>("/audit-logs"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load HR data");
    }
  }

  useEffect(() => { void load(); }, [status, severity, dateFilter, monthFilter]);

  async function scan() {
    setMessage("Scanning all employee timecards...");
    try {
      const result = await api<{ scanned: number; flagged: number }>("/exceptions/scan", { method: "POST" });
      setMessage(`Scan complete: ${result.scanned} combinations reviewed, ${result.flagged} exceptions created or updated.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Scan failed");
    }
  }

  const open = exceptions.filter((item) => item.status === "OPEN" || item.status === "PROPOSED").length;
  const high = exceptions.filter((item) => item.severity === "HIGH").length;
  const verified = exceptions.filter((item) => item.guardrailVerified).length;

  return (
    <div className="space-y-6">
      {message && <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">{message}</div>}
      <nav className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-1">{[
        ["queue", "Exception Queue"], ["employees", "Employee Directory"], ["leaves", "Leave Request Queue"], ["policies", "Policy Knowledge Base"], ["audit", "Immutable Audit Log"],
      ].map(([value, label]) => <button key={value} type="button" onClick={() => setTab(value as Tab)} className={`rounded-lg px-4 py-2 text-sm font-bold ${tab === value ? "bg-navy text-white" : "text-slate-500"}`}>{label}</button>)}</nav>

      {tab === "queue" && <>
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{[
          { label: "Open Exceptions", value: open, Icon: AlertTriangle },
          { label: "High Severity", value: high, Icon: ShieldCheck },
          { label: "Guardrail Verified", value: verified, Icon: FileCheck2 },
          { label: "Resolved Audit Count", value: audits.length, Icon: ClipboardCheck },
        ].map(({ label, value, Icon }) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex justify-between"><p className="text-sm text-slate-500">{label}</p><Icon size={18} className="text-teal" /></div><p className="mt-3 text-3xl font-bold text-navy">{value}</p></div>)}</section>
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4"><button type="button" onClick={() => void scan()} className="flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white"><RefreshCw size={16} /> Run Timecard Scan</button><input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><input type="month" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="UNRESOLVED">Active / Unresolved</option><option value="OPEN">OPEN</option><option value="PROPOSED">PROPOSED</option><option value="ESCALATED">ESCALATED</option><option value="APPROVED">APPROVED</option><option value="ALL">ALL</option></select><select value={severity} onChange={(event) => setSeverity(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>ALL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></section>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Region</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Anomaly</th><th className="px-4 py-3">Severity</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Guardrail</th><th></th></tr></thead><tbody>{exceptions.map((exception) => <tr key={exception.id} className="border-t border-slate-100"><td className="px-4 py-3"><b>{exception.employee.name}</b><br /><span className="text-xs text-slate-500">{exception.employee.empCode}</span></td><td className="px-4 py-3">{exception.employee.region}</td><td className="px-4 py-3">{exception.date}</td><td className="px-4 py-3">{exception.anomalyCode}</td><td className="px-4 py-3">{exception.severity}</td><td className="px-4 py-3">{exception.status}</td><td className="px-4 py-3">{exception.guardrailVerified ? "Verified" : "Pending"}</td><td className="px-4 py-3"><button type="button" onClick={() => setSelected(exception)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold">Inspect & Resolve</button></td></tr>)}</tbody></table></div>
      </>}
      {tab === "employees" && <EmployeeDirectory />}
      {tab === "leaves" && <LeaveQueueView />}
      {tab === "policies" && <PolicyManager />}
      {tab === "audit" && <AuditLogView />}
      {selected && <ResolutionDrawer exception={selected} onClose={() => setSelected(null)} onResolved={async () => {
        setSelected(null);
        await load();
      }} />}
    </div>
  );
}
