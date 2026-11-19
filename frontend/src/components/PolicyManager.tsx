import { useEffect, useState } from "react";
import { FileUp, Search } from "lucide-react";
import { api, type PolicyRule } from "../api";

export default function PolicyManager() {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("ALL");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    setPolicies(await api<PolicyRule[]>("/policies"));
  }

  useEffect(() => { void load(); }, []);

  async function upload() {
    if (!file) return;
    setMessage("Parsing document with Docling and indexing policy rules...");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("region", region);
      const result = await api<{ status: string; extractedRuleCount: number }>("/policies/upload", { method: "POST", body: form });
      setMessage(`Ingested ${result.extractedRuleCount} policy rules; Qdrant indexing complete.`);
      setFile(null);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy upload failed");
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
          <input type="file" accept=".pdf,.docx,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <select value={region} onChange={(event) => setRegion(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option>ALL</option><option>IN</option><option>US</option>
          </select>
          <button type="button" onClick={() => void upload()} disabled={!file} className="rounded-lg bg-teal px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Upload & Ingest</button>
        </div>
        {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
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
          </article>
        ))}
      </div>
    </div>
  );
}
