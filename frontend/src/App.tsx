import { useEffect, useState } from "react";
import { Clock3, LogOut, ShieldCheck, UserRound } from "lucide-react";
import AuthScreen from "./components/AuthScreen";
import EmployeePortal from "./components/EmployeePortal";
import HrDashboard from "./components/HrDashboard";
import { api, type Employee } from "./api";

type Session = {
  role: "EMPLOYEE" | "HR_ADMIN";
  profile: Employee | { hrEmail: string } | null;
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"employee" | "hr">("employee");

  useEffect(() => {
    const token = localStorage.getItem("chronopact_token");
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ role: "EMPLOYEE" | "HR_ADMIN"; profile: Session["profile"] }>("/auth/me")
      .then((result) => {
        setSession({ role: result.role, profile: result.profile });
        localStorage.setItem("chronopact_role", result.role);
        setView(result.role === "HR_ADMIN" ? "hr" : "employee");
      })
      .catch(() => {
        localStorage.removeItem("chronopact_token");
        localStorage.removeItem("chronopact_role");
      })
      .finally(() => setLoading(false));
  }, []);

  function logout() {
    localStorage.removeItem("chronopact_token");
    localStorage.removeItem("chronopact_role");
    setSession(null);
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading ChronoPact...</div>;
  if (!session) {
    return <AuthScreen onAuthenticated={(role, employee) => {
      setSession({ role, profile: employee as Session["profile"] });
      setView(role === "HR_ADMIN" ? "hr" : "employee");
    }} />;
  }

  const employeeProfile = session.role === "EMPLOYEE" ? session.profile as Employee : null;
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy text-white"><Clock3 size={22} /></div><div><p className="text-lg font-bold leading-none text-navy">ChronoPact</p><p className="mt-1 text-xs text-slate-500">Governed Time and Attendance AI Agent</p></div></div>
          <div className="flex items-center gap-2">
            {session.role === "HR_ADMIN" ? <button type="button" onClick={() => setView(view === "hr" ? "employee" : "hr")} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold">{view === "hr" ? "Preview Employee Portal" : "Back to HR Operations"}</button> : null}
            <span className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold">{session.role === "HR_ADMIN" ? <ShieldCheck size={15} /> : <UserRound size={15} />}{session.role === "HR_ADMIN" ? "HR Admin" : `${employeeProfile?.empCode ?? ""} · ${employeeProfile?.name ?? "Employee"}`}</span>
            <button type="button" onClick={logout} className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold"><LogOut size={15} /> Logout</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">
        {session.role === "EMPLOYEE" || view === "employee" ? <EmployeePortal forcedEmployeeId={employeeProfile?.id} isHrPreview={session.role === "HR_ADMIN"} /> : <HrDashboard />}
      </main>
    </div>
  );
}
