import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api, type AuditRecord } from "../api";

export default function AuditLogView() {
  const [records, setRecords] = useState<AuditRecord[]>([]);

  useEffect(() => { api<AuditRecord[]>("/audit-logs").then(setRecords).catch(() => setRecords([])); }, []);

  function exportCsv() {
    const headers = ["Timestamp", "Employee", "Decision", "Cited Policy", "Approved By", "Notes"];
    const rows = records.map((record) => [
      record.createdAt,
      `${record.employee?.empCode ?? ""} ${record.employee?.name ?? ""}`,
      record.decision,
      record.citedPolicyCode,
      record.actionBy,
      record.notes,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "chronopact-audit-log.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><button type="button" onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold"><Download size={16} /> Export CSV</button></div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Timestamp</th><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Decision</th><th className="px-4 py-3">Cited Policy</th><th className="px-4 py-3">Before / After</th><th className="px-4 py-3">Approved By</th><th className="px-4 py-3">Notes</th></tr></thead>
          <tbody>{records.map((record) => (
            <tr key={record.id} className="border-t border-slate-100">
              <td className="px-4 py-3">{new Date(record.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC</td>
              <td className="px-4 py-3 font-semibold">{record.employee?.name} <span className="text-slate-400">({record.employee?.empCode})</span></td>
              <td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold">{record.decision}</span></td>
              <td className="px-4 py-3">{record.citedPolicyCode}</td>
              <td className="px-4 py-3 text-xs">{Array.isArray(record.beforePunchesJson) ? record.beforePunchesJson.length : 0} / {Array.isArray(record.afterPunchesJson) ? record.afterPunchesJson.length : 0} punches</td>
              <td className="px-4 py-3">{record.actionBy}</td><td className="px-4 py-3">{record.notes}</td>
            </tr>
          ))}</tbody>
        </table>
        {records.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No audit records yet.</p>}
      </div>
    </div>
  );
}
