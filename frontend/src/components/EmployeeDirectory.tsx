import { useEffect, useState } from "react";
import { Search, UserPlus } from "lucide-react";
import { api, type Employee } from "../api";
import EmployeeProfileDrawer from "./EmployeeProfileDrawer";

export default function EmployeeDirectory() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Employee | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    setEmployees(await api<Employee[]>("/employees"));
  }
  useEffect(() => { void load(); }, []);

  const filtered = employees.filter((employee) =>
    `${employee.empCode} ${employee.name} ${employee.department} ${employee.team ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {message && <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm">{message}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-md flex-1"><Search className="absolute left-3 top-2.5 text-slate-400" size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee, code, department, or team" className="w-full rounded-lg border border-slate-300 py-2 pl-10 pr-3 text-sm" /></div>
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white"><UserPlus size={16} /> Add Employee</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Team</th><th className="px-4 py-3">Shift</th><th className="px-4 py-3">Account Status</th><th className="px-4 py-3"></th></tr></thead><tbody>{filtered.map((employee) => (
          <tr key={employee.id} className="border-t border-slate-100"><td className="px-4 py-3"><span className="font-bold">{employee.name}</span><br /><span className="text-xs text-slate-500">{employee.empCode}</span></td><td className="px-4 py-3">{employee.department}</td><td className="px-4 py-3">{employee.team ?? "Core Operations"}</td><td className="px-4 py-3">{employee.region} Operations</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${employee.isRegistered ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{employee.isRegistered ? "Activated" : "Pending Registration"}</span></td><td className="px-4 py-3"><button type="button" onClick={() => setSelected(employee)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold">View / Edit 360</button></td></tr>
        ))}</tbody></table>
      </div>
      {selected && <EmployeeProfileDrawer employee={selected} onClose={() => setSelected(null)} onUpdated={() => void load()} />}
      {adding && <ProvisionEmployeeModal onClose={() => setAdding(false)} onCreated={async () => { setAdding(false); setMessage("Employee provisioned successfully."); await load(); }} />}
    </div>
  );
}

function ProvisionEmployeeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ empCode: "", name: "", email: "", department: "", team: "", role: "EMPLOYEE", region: "IN", shiftStart: "09:00", shiftEnd: "17:00", address: "", phone: "", status: "PENDING_REGISTRATION" });
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/employees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Provisioning failed");
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4"><form onSubmit={submit} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex justify-between"><h2 className="text-lg font-bold text-navy">Add Employee</h2><button type="button" onClick={onClose}>×</button></div>{error && <p className="mt-3 text-sm text-red-600">{error}</p>}<div className="mt-4 grid gap-3 sm:grid-cols-2">{Object.entries(form).filter(([key]) => key !== "region").map(([key, value]) => <input key={key} required={key !== "address" && key !== "phone"} placeholder={key} value={value} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />)}<select value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>IN</option><option>US</option></select></div><button type="submit" className="mt-5 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white">Provision Employee</button></form></div>
  );
}
