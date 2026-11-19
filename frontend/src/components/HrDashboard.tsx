import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardCheck, FileCheck2, Plus, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { api, type AuditRecord, type Employee, type ExceptionItem } from "../api";
import ResolutionDrawer from "./ResolutionDrawer";
import PolicyManager from "./PolicyManager";
import AuditLogView from "./AuditLogView";

type Tab = "queue" | "policies" | "audit";

export default function HrDashboard() {
  const [tab, setTab] = useState<Tab>("queue");
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [status, setStatus] = useState("ALL");
  const [severity, setSeverity] = useState("ALL");
  const [selected, setSelected] = useState<ExceptionItem | null>(null);
  const [modal, setModal] = useState<"employee" | "punch" | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (status !== "ALL") params.set("status", status);
    if (severity !== "ALL") params.set("severity", severity);
    try {
      setExceptions(await api<ExceptionItem[]>(`/exceptions${params.size ? `?${params}` : ""}`));
      setAudits(await api<AuditRecord[]>("/audit-logs"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load HR data");
    }
  }

  useEffect(() => { void load(); }, [status, severity]);

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
      <nav className="flex gap-2 rounded-xl border border-slate-200 bg-white p-1">
        {([["queue", "Exception Queue"], ["policies", "Policy Knowledge Base"], ["audit", "Immutable Audit Log"]] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setTab(value)} className={`rounded-lg px-4 py-2 text-sm font-bold ${tab === value ? "bg-navy text-white" : "text-slate-500"}`}>{label}</button>
        ))}
      </nav>

      {tab === "queue" && (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Open Exceptions", value: open, Icon: AlertTriangle },
              { label: "High Severity", value: high, Icon: ShieldCheck },
              { label: "Guardrail Verified", value: verified, Icon: FileCheck2 },
              { label: "Resolved Audit Count", value: audits.length, Icon: ClipboardCheck },
            ].map(({ label, value, Icon }) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex justify-between"><p className="text-sm text-slate-500">{label}</p><Icon size={18} className="text-teal" /></div><p className="mt-3 text-3xl font-bold text-navy">{value}</p></div>
            ))}
          </section>

          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <button type="button" onClick={() => void scan()} className="flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white"><RefreshCw size={16} /> Run Timecard Scan</button>
            <button type="button" onClick={() => setModal("employee")} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"><UserPlus size={16} /> Add Employee</button>
            <button type="button" onClick={() => setModal("punch")} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold"><Plus size={16} /> Manual Punch</button>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>ALL</option><option>OPEN</option><option>PROPOSED</option><option>APPROVED</option><option>ESCALATED</option></select>
            <select value={severity} onChange={(event) => setSeverity(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>ALL</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select>
          </section>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Region</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">Anomaly</th><th className="px-4 py-3">Severity</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Guardrail</th><th className="px-4 py-3"></th></tr></thead>
              <tbody>{exceptions.map((exception) => (
                <tr key={exception.id} className="border-t border-slate-100">
                  <td className="px-4 py-3"><span className="font-bold">{exception.employee.name}</span><br /><span className="text-xs text-slate-500">{exception.employee.empCode}</span></td>
                  <td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold">{exception.employee.region}</span></td>
                  <td className="px-4 py-3">{exception.date}</td><td className="px-4 py-3 font-semibold">{exception.anomalyCode}</td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${exception.severity === "HIGH" ? "bg-red-100 text-red-700" : exception.severity === "MEDIUM" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"}`}>{exception.severity}</span></td>
                  <td className="px-4 py-3"><span className="rounded-full bg-sky-100 px-2 py-1 text-xs font-bold text-sky-700">{exception.status}</span></td>
                  <td className="px-4 py-3">{exception.guardrailVerified ? <span className="text-emerald-700">Verified</span> : <span className="text-slate-400">Pending</span>}</td>
                  <td className="px-4 py-3"><button type="button" onClick={() => setSelected(exception)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold hover:border-teal">Inspect & Resolve</button></td>
                </tr>
              ))}</tbody>
            </table>
            {exceptions.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No exceptions match these filters.</p>}
          </div>
        </>
      )}

      {tab === "policies" && <PolicyManager />}
      {tab === "audit" && <AuditLogView />}
      {selected && <ResolutionDrawer exception={selected} onClose={() => setSelected(null)} onResolved={() => void load()} />}
      {modal && <HrModal kind={modal} onClose={() => setModal(null)} onComplete={() => { setModal(null); void load(); }} />}
    </div>
  );
}

function HrModal({ kind, onClose, onComplete }: { kind: "employee" | "punch"; onClose: () => void; onComplete: () => void }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [message, setMessage] = useState("");
  const [employee, setEmployee] = useState({ empCode: "", name: "", email: "", role: "", department: "", region: "IN", hourlyRate: 25 });
  const [punch, setPunch] = useState({ employeeId: "", punchType: "IN", timestamp: new Date().toISOString().slice(0, 16) });

  useEffect(() => { api<Employee[]>("/employees").then(setEmployees).catch(() => setEmployees([])); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (kind === "employee") await api("/employees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(employee) });
      else await api("/punches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId: punch.employeeId, punchType: punch.punchType, timestamp: new Date(punch.timestamp).toISOString(), source: "HR_MANUAL" }) });
      onComplete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4"><form onSubmit={submit} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><div className="flex justify-between"><h2 className="text-lg font-bold text-navy">{kind === "employee" ? "Add Employee" : "Log Manual Punch"}</h2><button type="button" onClick={onClose}>×</button></div>{message && <p className="mt-3 text-sm text-red-600">{message}</p>}
      {kind === "employee" ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(["empCode","name","email","role","department"] as const).map((field) => <input key={field} required placeholder={field} value={employee[field]} onChange={(event) => setEmployee({ ...employee, [field]: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />)}
        <select value={employee.region} onChange={(event) => setEmployee({ ...employee, region: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>IN</option><option>US</option></select>
        <input type="number" min="1" value={employee.hourlyRate} onChange={(event) => setEmployee({ ...employee, hourlyRate: Number(event.target.value) })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </div> : <div className="mt-4 grid gap-3"><select required value={punch.employeeId} onChange={(event) => setPunch({ ...punch, employeeId: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="">Select employee</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.empCode} - {item.name}</option>)}</select><select value={punch.punchType} onChange={(event) => setPunch({ ...punch, punchType: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>IN</option><option>BREAK_START</option><option>BREAK_END</option><option>OUT</option></select><input type="datetime-local" value={punch.timestamp} onChange={(event) => setPunch({ ...punch, timestamp: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /></div>}
      <button type="submit" className="mt-5 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white">Save</button></form></div>
  );
}
