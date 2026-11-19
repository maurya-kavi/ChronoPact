import { useState } from "react";
import { Clock3, ShieldCheck, UserRound } from "lucide-react";
import EmployeePortal from "./components/EmployeePortal";
import HrDashboard from "./components/HrDashboard";

type ViewMode = "employee" | "hr";

export default function App() {
  const [view, setView] = useState<ViewMode>("employee");

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy text-white"><Clock3 size={22} /></div>
            <div><p className="text-lg font-bold leading-none text-navy">ChronoPact</p><p className="mt-1 text-xs text-slate-500">Governed Time and Attendance AI Agent</p></div>
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">Open-Weight LLM Active</span>
            <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700">Qdrant RAG Ready</span>
          </div>
          <nav className="flex rounded-lg border border-slate-200 bg-slate-100 p-1" aria-label="Role switcher">
            <button type="button" onClick={() => setView("employee")} aria-pressed={view === "employee"} className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-bold ${view === "employee" ? "bg-white text-navy shadow-sm" : "text-slate-500"}`}><UserRound size={16} /> Employee Portal</button>
            <button type="button" onClick={() => setView("hr")} aria-pressed={view === "hr"} className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-bold ${view === "hr" ? "bg-white text-navy shadow-sm" : "text-slate-500"}`}><ShieldCheck size={16} /> HR Admin Operations</button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{view === "employee" ? <EmployeePortal /> : <HrDashboard />}</main>
    </div>
  );
}
