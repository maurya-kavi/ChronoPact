import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, X } from "lucide-react";
import { api, type ExceptionItem, type PolicyRule, type ProposedPunch } from "../api";

function formatUtcTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "--";
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function toUtcDatetimeLocal(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 16);
}

function fromUtcDatetimeLocal(value: string): string {
  const normalized = value.length === 16 ? `${value}:00.000Z` : value.endsWith("Z") ? value : `${value}Z`;
  return normalized;
}

interface Props {
  exception: ExceptionItem | null;
  onClose: () => void;
  onResolved: () => void;
}

export default function ResolutionDrawer({ exception, onClose, onResolved }: Props) {
  const [proposal, setProposal] = useState<ExceptionItem["aiProposalJson"]>(null);
  const [guardrailVerified, setGuardrailVerified] = useState(false);
  const [remainingAnomalies, setRemainingAnomalies] = useState<Array<{ anomalyCode: string; severity: string }>>([]);
  const [edited, setEdited] = useState<ProposedPunch[]>([]);
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!exception) return;
    api<PolicyRule[]>("/policies").then(setPolicies).catch(() => setPolicies([]));
    if (exception.aiProposalJson) {
      setProposal(exception.aiProposalJson);
      setEdited(exception.aiProposalJson.proposedPunches);
      setGuardrailVerified(
        typeof exception.aiProposalJson.guardrailVerified === "boolean"
          ? exception.aiProposalJson.guardrailVerified
          : exception.guardrailVerified,
      );
      setRemainingAnomalies(exception.aiProposalJson.remainingAnomalies ?? []);
    } else {
      void generate();
    }
  }, [exception?.id]);

  async function generate() {
    if (!exception) return;
    setMessage("");
    setLoading(true);
    try {
      const result = await api<{
        aiProposalJson: NonNullable<ExceptionItem["aiProposalJson"]>;
        guardrailVerified: boolean;
        remainingAnomalies: Array<{ anomalyCode: string; severity: string }>;
      }>(`/exceptions/${exception.id}/propose`, { method: "POST" });
      setProposal(result.aiProposalJson);
      setEdited(result.aiProposalJson.proposedPunches);
      setGuardrailVerified(result.guardrailVerified);
      setRemainingAnomalies(result.remainingAnomalies);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI proposal failed");
    } finally {
      setLoading(false);
    }
  }

  async function resolve(decision: "APPROVED" | "EDITED_AND_APPROVED" | "ESCALATED") {
    if (!exception) return;
    setMessage("");
    setSubmitting(true);
    try {
      await api(`/exceptions/${exception.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          actionBy: reviewer.trim() || "HR Admin",
          reviewerName: reviewer.trim() || "HR Admin",
          citedPolicyCode: proposal?.citedPolicyCode,
          notes,
          editedPunches: decision === "EDITED_AND_APPROVED" ? edited : undefined,
        }),
      });
      setMessage("");
      onResolved();
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Resolution failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!exception) return null;
  const cited = policies.find((policy) => policy.policyCode === proposal?.citedPolicyCode);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30" role="dialog" aria-modal="true">
      <div className="h-full w-full max-w-5xl overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div><p className="text-xs font-bold uppercase text-teal">Exception Resolution</p><h2 className="text-xl font-bold text-navy">{exception.anomalyCode}</h2></div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-slate-100"><X size={20} /></button>
        </div>
        <div className="space-y-5 p-6">
          {loading && <div className="flex items-center gap-2 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900"><RefreshCw className="animate-spin" size={16} /> Generating or resolving proposal...</div>}
          {message && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</div>}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 p-5">
              <h3 className="font-bold text-navy">Deterministic Rule Engine Findings</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.entries(exception.deterministicDetailsJson).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4 border-b border-slate-100 py-2"><dt className="text-slate-500">{key}</dt><dd className="font-semibold text-right">{String(value)}</dd></div>
                ))}
              </dl>
            </section>
            <section className="rounded-xl border border-slate-200 p-5">
              <h3 className="font-bold text-navy">Cited Policy Clause</h3>
              {proposal ? (
                <><span className="mt-3 inline-block rounded-full bg-teal/10 px-3 py-1 text-xs font-bold text-teal">{proposal.citedPolicyCode}</span><p className="mt-3 text-sm leading-6 text-slate-600">{cited?.ruleText ?? "Retrieved policy text unavailable."}</p></>
              ) : <p className="mt-3 text-sm text-slate-500">Awaiting AI proposal.</p>}
            </section>
          </div>

          {proposal && (
            <>
              <section className="rounded-xl border border-slate-200 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h3 className="font-bold text-navy">AI Root-Cause Explanation</h3><p className="mt-2 text-sm leading-6 text-slate-600">{proposal.rootCauseExplanation}</p></div>
                  <div className="flex flex-col items-end gap-1"><span className="rounded-full bg-navy px-3 py-1 text-xs font-bold text-white">{Math.round(proposal.confidenceScore * 100)}% confidence</span>{proposal.modelUsed && <span className="text-[11px] text-slate-500">Open-weight model: {proposal.modelUsed}</span>}</div>
                </div>
              </section>
              <section className={`flex items-start gap-3 rounded-xl border p-4 ${guardrailVerified ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                {guardrailVerified ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
                <div><p className="font-bold">{guardrailVerified ? "Guardrail Verified Safe" : "Guardrail Warning"}</p>
                  {!guardrailVerified && <p className="mt-1 text-sm">Remaining anomalies: {remainingAnomalies.map((item) => item.anomalyCode).join(", ") || "None listed"}</p>}
                </div>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 p-5"><h3 className="font-bold text-navy">Before</h3><div className="mt-3 space-y-2">{exception.punches.map((punch) => <div key={punch.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"><span>{punch.punchType}</span><span>{formatUtcTime(punch.timestamp)}</span></div>)}</div></div>
                <div className="rounded-xl border border-slate-200 p-5"><div className="flex justify-between"><h3 className="font-bold text-navy">After</h3><button type="button" onClick={() => void generate()} className="flex items-center gap-1 text-xs font-bold text-teal"><RefreshCw size={14} /> Re-run AI Proposal</button></div><div className="mt-3 space-y-2">{edited.map((punch, index) => (
                  <label key={`${punch.punchType}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-teal/5 px-3 py-2 text-sm"><span className="font-semibold">{punch.punchType}</span><input type="datetime-local" value={toUtcDatetimeLocal(punch.isoTimestamp)} onChange={(event) => setEdited((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, isoTimestamp: fromUtcDatetimeLocal(event.target.value) } : item))} className="rounded border border-slate-300 px-2 py-1" /></label>
                ))}</div></div>
              </section>
            </>
          )}

          <section className="rounded-xl border border-slate-200 p-5">
            <h3 className="font-bold text-navy">Human-in-the-Loop Decision</h3>
            <div className="mt-4 grid gap-3 md:grid-cols-2"><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="HR reviewer name" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" /><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Audit notes" className="rounded-lg border border-slate-300 px-3 py-2 text-sm md:row-span-1" /></div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={() => void resolve("APPROVED")} disabled={!proposal || loading || submitting} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{submitting ? "Saving Decision..." : "Approve Proposal"}</button>
              <button type="button" onClick={() => void resolve("EDITED_AND_APPROVED")} disabled={!proposal || loading || submitting} className="rounded-lg bg-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{submitting ? "Saving Decision..." : "Save Edited Time and Approve"}</button>
              <button type="button" onClick={() => void resolve("ESCALATED")} disabled={loading || submitting} className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800">{submitting ? "Saving Decision..." : "Escalate to Senior HR"}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
