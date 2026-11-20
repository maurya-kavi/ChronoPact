import { useEffect, useState } from "react";
import { FileUp, Search } from "lucide-react";
import { api, type PolicyRule } from "../api";
import type { PolicyDocumentHistory } from "./PolicyDocumentTypes";
import { formatIstDateTime } from "../utils/istTime";

export default function PolicyManager() {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("ALL");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [documents, setDocuments] = useState<PolicyDocumentHistory[]>([]);
  const [editing, setEditing] = useState<PolicyRule | null>(null);
  const [editJson, setEditJson] = useState("{}");

  async function load() {
    setPolicies(await api<PolicyRule[]>("/policies"));
    setDocuments(await api<PolicyDocumentHistory[]>("/policies/documents"));
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const active = documents.some((document) =>
      ["QUEUED", "EXTRACTING", "CHUNKING", "EMBEDDING", "EXTRACTING_RULES"].includes(document.status),
    );
    if (!active) return;
    const interval = window.setInterval(async () => {
      await load();
      const latest = await api<PolicyDocumentHistory[]>("/policies/documents");
      if (latest.some((document) => document.status === "DONE")) {
        setPolicies(await api<PolicyRule[]>("/policies"));
      }
      setDocuments(latest);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [documents]);

  async function upload() {
    if (!file) return;
    setMessage("Parsing document with Docling and indexing policy rules...");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("region", region);
      await api<{ status: string; document: PolicyDocumentHistory }>("/policies/upload", { method: "POST", body: form });
      setMessage("Document queued in background — you can upload additional files anytime");
      setFile(null);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy upload failed");
    }
  }

  function startEdit(policy: PolicyRule) {
    setEditing({ ...policy });
    setEditJson(JSON.stringify(policy.thresholdJson, null, 2));
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    let thresholdJson: Record<string, unknown>;
    try {
      thresholdJson = JSON.parse(editJson);
      if (!thresholdJson || Array.isArray(thresholdJson) || typeof thresholdJson !== "object") throw new Error("Threshold must be a JSON object");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invalid threshold JSON");
      return;
    }
    try {
      await api(`/policies/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editing.title,
          category: editing.category,
          region: editing.region,
          ruleText: editing.ruleText,
          thresholdJson,
        }),
      });
      setEditing(null);
      setMessage("Policy updated; Qdrant RAG and deterministic thresholds refreshed.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy update failed");
    }
  }

  async function deletePolicy(policy: PolicyRule) {
    if (!window.confirm(`Delete ${policy.policyCode} (${policy.title})? This removes it from Qdrant and the rule engine.`)) return;
    try {
      await api(`/policies/${policy.id}`, { method: "DELETE" });
      setMessage("Policy deleted; Qdrant RAG and rule thresholds updated.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy deletion failed");
    }

  }

  async function retryDocument(documentId: string) {
    try {
      await api(`/policies/documents/${documentId}/retry`, { method: "POST" });
      setMessage("Policy document retry queued.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry failed");
    }
  }

  const filtered = policies.filter((policy) =>
    `${policy.policyCode} ${policy.title} ${policy.ruleText}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy"><FileUp size={19} /> Policy Document Upload</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <input type="file" accept=".pdf,.docx,.txt,.md,.csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={region} onChange={(event) => setRegion(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option>ALL</option><option>IN</option><option>US</option>
          </select>
          <button type="button" onClick={() => void upload()} disabled={!file} className="rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Upload & Ingest</button>
        </div>
        {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
      </section>

      <section className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4"><h2 className="font-bold text-navy">Uploaded Policy Documents History</h2></div>
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">File Name</th><th className="px-4 py-3">Region</th><th className="px-4 py-3">Extracted Rules</th><th className="px-4 py-3">Policy Codes</th><th className="px-4 py-3 min-w-72">Background Progress</th><th className="px-4 py-3">Uploaded</th></tr></thead>
          <tbody>{documents.map((document) => (
            <tr key={document.id} className="border-t border-slate-100">
              <td className="px-4 py-3 font-semibold">{document.fileName}</td>
              <td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{document.region}</span></td>
              <td className="px-4 py-3">{document.extractedCount}</td>
              <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{(document.extractedPolicyCodesJson ?? []).map((code) => <span key={code} className="rounded-full bg-teal/10 px-2 py-1 text-xs font-bold text-teal">{code}</span>)}</div></td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1 text-[10px] font-bold">
                  {["QUEUED", "EXTRACTING", "CHUNKING", "EMBEDDING", "DONE"].map((stage, index) => {
                    const stageIndex = ["QUEUED", "EXTRACTING", "CHUNKING", "EMBEDDING", "DONE"].indexOf(document.status);
                    const failedStage = document.status === "FAILED";
                    const active = failedStage ? false : index <= stageIndex;
                    return <span key={stage} className={`h-2 w-8 rounded-full ${active ? document.status === "FAILED" ? "bg-red-300" : "bg-teal" : "bg-slate-200"}`} title={stage} />;
                  })}
                </div>
                <p className="mt-2 text-xs">{document.currentStep}</p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${document.status === "FAILED" ? "bg-red-500" : "bg-teal"}`} style={{ width: `${document.progressPercent}%` }} /></div>
                <p className="mt-1 text-xs text-slate-500">{document.progressPercent}% · {document.processedChunks}/{document.totalChunks} chunks</p>
                {document.status === "FAILED" && <div className="mt-2"><span className="rounded bg-red-100 px-2 py-1 text-xs font-bold text-red-700">FAILED</span><p className="mt-1 text-xs text-red-700">{document.errorMessage}</p><button type="button" onClick={() => void retryDocument(document.id)} className="mt-2 rounded-lg border border-red-300 px-2 py-1 text-xs font-bold text-red-700">Retry</button></div>}
                {document.status === "DONE" && <span className="mt-2 inline-block rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700">DONE</span>}
              </td>
              <td className="px-4 py-3">{formatIstDateTime(document.uploadedAt)}</td>
            </tr>
          ))}</tbody>
        </table>
        {documents.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No policy documents uploaded yet.</p>}
      </section>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 text-slate-400" size={17} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search policy code or rule..." className="w-full rounded-lg border border-slate-300 py-2 pl-10 pr-3 text-sm" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((policy) => (
          <article key={policy.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-2"><span className="font-bold text-navy">{policy.policyCode}</span><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{policy.region}</span></div>
            <p className="mt-2 font-semibold">{policy.title}</p>
            <span className="mt-2 inline-block rounded-full bg-teal/10 px-2 py-1 text-xs font-bold text-teal">{policy.category}</span>
            <p className="mt-3 text-sm leading-6 text-slate-600">{policy.ruleText}</p>
            <pre className="mt-3 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-200">{JSON.stringify(policy.thresholdJson, null, 2)}</pre>
            <div className="mt-4 flex gap-2"><button type="button" onClick={() => startEdit(policy)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold">Edit</button><button type="button" onClick={() => void deletePolicy(policy)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700">Delete</button></div>
          </article>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4">
          <form onSubmit={saveEdit} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-navy">Edit {editing.policyCode}</h2><button type="button" onClick={() => setEditing(null)}>×</button></div>
            <div className="mt-4 grid gap-3">
              <input required value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <div className="grid grid-cols-2 gap-3"><select value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value as PolicyRule["category"] })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>PUNCH</option><option>OVERTIME</option><option>BREAK</option><option>REST_GAP</option><option>LEAVE</option><option>SCHEDULE</option></select><select value={editing.region} onChange={(event) => setEditing({ ...editing, region: event.target.value as PolicyRule["region"] })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm"><option>ALL</option><option>IN</option><option>US</option></select></div>
              <textarea required rows={4} value={editing.ruleText} onChange={(event) => setEditing({ ...editing, ruleText: event.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <textarea required rows={6} value={editJson} onChange={(event) => setEditJson(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" />
            </div>
            <div className="mt-4 flex gap-2"><button type="submit" className="rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white">Save & Sync</button><button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold">Cancel</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
