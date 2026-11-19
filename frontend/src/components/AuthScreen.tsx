import { useState } from "react";
import { Building2, ShieldCheck, UserRound } from "lucide-react";
import { api } from "../api";

type Props = {
  onAuthenticated: (role: "EMPLOYEE" | "HR_ADMIN", employee: unknown) => void;
};

export default function AuthScreen({ onAuthenticated }: Props) {
  const [tab, setTab] = useState<"employee" | "register" | "hr">("employee");
  const [empCode, setEmpCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [hrEmail, setHrEmail] = useState("");
  const [hrPassword, setHrPassword] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      let result: { token: string; role: "EMPLOYEE" | "HR_ADMIN"; employee: unknown };
      if (tab === "employee") {
        result = await api("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ empCode, password }) });
      } else if (tab === "register") {
        result = await api("/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ empCode, password, confirmPassword }) });
      } else {
        result = await api("/auth/hr-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hrEmail, password: hrPassword }) });
      }
      localStorage.setItem("chronopact_token", result.token);
      onAuthenticated(result.role, result.employee);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy text-white"><Building2 size={22} /></div><div><h1 className="text-xl font-bold text-navy">ChronoPact</h1><p className="text-xs text-slate-500">Governed Workforce Access</p></div></div>
        <div className="mt-6 grid grid-cols-3 rounded-lg bg-slate-100 p-1">
          <button type="button" onClick={() => setTab("employee")} className={`rounded-md px-2 py-2 text-xs font-bold ${tab === "employee" ? "bg-white text-navy shadow" : "text-slate-500"}`}><UserRound size={14} className="mx-auto mb-1" />Employee Login</button>
          <button type="button" onClick={() => setTab("register")} className={`rounded-md px-2 py-2 text-xs font-bold ${tab === "register" ? "bg-white text-navy shadow" : "text-slate-500"}`}>First-Time Registration</button>
          <button type="button" onClick={() => setTab("hr")} className={`rounded-md px-2 py-2 text-xs font-bold ${tab === "hr" ? "bg-white text-navy shadow" : "text-slate-500"}`}><ShieldCheck size={14} className="mx-auto mb-1" />HR Admin</button>
        </div>
        {message && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>}
        <form onSubmit={submit} className="mt-5 space-y-3">
          {tab !== "hr" ? <>
            <input required value={empCode} onChange={(event) => setEmpCode(event.target.value)} placeholder="Employee ID (EMP001)" className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm" />
            {tab === "employee" && <button type="button" onClick={() => { setEmpCode("EMP001"); setPassword("Pass@123"); }} className="text-xs font-bold text-teal">1-click Demo Fill: EMP001 / Pass@123</button>}
            {tab === "register" && <p className="text-xs text-slate-500">Your Employee ID must be pre-created by HR before first-time activation.</p>}
            <input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm" />
            {tab === "register" && <input required type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm Password" className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm" />}
          </> : <>
            <input required type="email" value={hrEmail} onChange={(event) => setHrEmail(event.target.value)} placeholder="HR admin email" className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm" />
            <button type="button" onClick={() => { setHrEmail("admin@chronopact.io"); setHrPassword("Admin@123"); }} className="text-xs font-bold text-teal">1-click HR Demo Fill</button>
            <input required type="password" value={hrPassword} onChange={(event) => setHrPassword(event.target.value)} placeholder="Password" className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm" />
          </>}
          <button type="submit" className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-bold text-white">{tab === "register" ? "Activate Account" : tab === "hr" ? "Sign in to HR Admin" : "Sign in"}</button>
        </form>
      </div>
    </div>
  );
}
