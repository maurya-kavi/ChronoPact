import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Send, Sparkles, Trash2 } from "lucide-react";
import { api } from "../api";
import type { PolicyDocumentHistory } from "./PolicyDocumentTypes";

type Citation = { documentName: string; policyCode: string | null; snippet: string; score: number };
type ChatResponse = { answer: string; citations: Citation[]; modelUsed: string; qdrantChunksSearched: number; retrievalSource: "QDRANT" | "POSTGRES_FALLBACK" };
type Message = { role: "user" | "assistant"; content: string; citations?: Citation[]; modelUsed?: string; retrievalSource?: ChatResponse["retrievalSource"] };

const starters = [
  "What is the maximum daily overtime limit before prior approval is needed?",
  "When is a meal break mandatory during a shift?",
  "How are punches logged during an approved leave handled?",
  "What shift window variance triggers a schedule mismatch exception?",
];

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function renderMarkdown(text: string) {
  return <div className="space-y-2 text-sm leading-6">{text.split("\n").map((line, index) => {
    if (!line.trim()) return <div key={index} className="h-1" />;
    if (/^[-*]\s+/.test(line)) return <div key={index} className="flex gap-2 pl-1"><span>•</span><span>{renderInline(line.replace(/^[-*]\s+/, ""))}</span></div>;
    if (/^\d+\.\s+/.test(line)) return <div key={index} className="pl-1">{renderInline(line)}</div>;
    if (line.startsWith("### ")) return <h4 key={index} className="font-bold">{renderInline(line.slice(4))}</h4>;
    if (line.startsWith("## ")) return <h3 key={index} className="text-base font-bold">{renderInline(line.slice(3))}</h3>;
    if (line.startsWith("# ")) return <h3 key={index} className="text-lg font-bold">{renderInline(line.slice(2))}</h3>;
    return <p key={index}>{renderInline(line)}</p>;
  })}</div>;
}

export default function PolicyChatTab() {
  const [documents, setDocuments] = useState<PolicyDocumentHistory[]>([]);
  const [documentName, setDocumentName] = useState("ALL");
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retrievalSource, setRetrievalSource] = useState<ChatResponse["retrievalSource"]>("QDRANT");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<PolicyDocumentHistory[]>("/policies/documents").then(setDocuments).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Unable to load policy documents");
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function sendQuestion(value: string) {
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    setQuestion("");
    setError("");
    setLoading(true);
    const nextMessages: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    try {
      const result = await api<ChatResponse>("/policies/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          documentName,
          history: messages.map(({ role, content }) => ({ role, content })),
        }),
      });
      setRetrievalSource(result.retrievalSource);
      setMessages([...nextMessages, { role: "assistant", content: result.answer, citations: result.citations, modelUsed: result.modelUsed, retrievalSource: result.retrievalSource }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The policy chat could not answer right now. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendQuestion(question);
    }
  }

  function clearChat() {
    setMessages([]);
    setQuestion("");
    setError("");
    setRetrievalSource("QDRANT");
  }

  return (
    <section className="flex min-h-[680px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal/10 text-teal"><Bot size={21} /></div>
          <div><h2 className="font-bold text-navy">HR Policy Chat</h2><span className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ${retrievalSource === "QDRANT" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}><span className={`h-1.5 w-1.5 rounded-full ${retrievalSource === "QDRANT" ? "bg-emerald-500" : "bg-amber-500"}`} />{retrievalSource === "QDRANT" ? "Grounded in Qdrant Vector DB" : "PostgreSQL PolicyRule fallback"}</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Document scope" value={documentName} onChange={(event) => setDocumentName(event.target.value)} className="max-w-xs rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="ALL">All Uploaded Documents</option>
            {documents.map((document) => <option key={document.id} value={document.fileName}>{document.fileName}</option>)}
          </select>
          <button type="button" onClick={clearChat} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"><Trash2 size={15} />Clear Chat</button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto bg-slate-50/70 p-5">
        {messages.length === 0 && <div className="mx-auto max-w-3xl py-8">
          <div className="rounded-2xl border border-teal/15 bg-white p-6 text-center shadow-sm"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-teal/10 text-teal"><Sparkles size={23} /></div><h3 className="mt-4 text-xl font-bold text-navy">Ask your uploaded policies</h3><p className="mt-2 text-sm text-slate-500">Answers are grounded in policy passages retrieved from Qdrant and include source citations.</p></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{starters.map((starter) => <button key={starter} type="button" onClick={() => void sendQuestion(starter)} className="rounded-xl border border-slate-200 bg-white p-4 text-left text-sm font-medium text-slate-700 shadow-sm transition hover:border-teal hover:text-navy">{starter}</button>)}</div>
        </div>}
        {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
          <article className={`max-w-[88%] rounded-2xl p-4 shadow-sm ${message.role === "user" ? "rounded-br-md bg-navy text-white" : "rounded-bl-md border border-slate-200 bg-white text-slate-800"}`}>
            {message.role === "assistant" ? <>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-teal"><Bot size={15} />Policy Assistant{message.modelUsed && <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{message.modelUsed}</span>}</div>
              {renderMarkdown(message.content)}
              {!!message.citations?.length && <div className="mt-4 space-y-2">{message.citations.map((citation, citationIndex) => <details key={`${citation.documentName}-${citationIndex}`} className="rounded-lg border border-slate-200 bg-slate-50">
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-navy">{message.retrievalSource === "QDRANT" ? "Sources from Qdrant" : "Sources from PostgreSQL fallback"} · {citation.documentName}</summary>
                <div className="space-y-2 border-t border-slate-200 px-3 py-3 text-xs"><div className="flex flex-wrap gap-2"><span className="rounded-full bg-teal/10 px-2 py-1 font-bold text-teal">{citation.policyCode ?? "Policy passage"}</span><span className="rounded-full bg-slate-200 px-2 py-1 font-semibold text-slate-600">Match {Math.round(citation.score * 100)}%</span></div><blockquote className="border-l-2 border-teal pl-3 leading-5 text-slate-600">“{citation.snippet}”</blockquote></div>
              </details>)}</div>}
            </> : renderMarkdown(message.content)}
          </article>
        </div>)}
        {loading && <div className="flex justify-start"><div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={16} />Searching policy documents in Qdrant…</div></div>}
        {error && <div role="alert" className="mx-auto max-w-3xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void sendQuestion(question); }} className="border-t border-slate-200 bg-white p-4">
        <div className="mx-auto flex max-w-4xl items-end gap-3 rounded-xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-teal">
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleKeyDown} rows={2} placeholder="Ask a question about your uploaded policies…" className="max-h-36 min-h-12 flex-1 resize-y bg-transparent px-2 py-2 text-sm outline-none" />
          <button type="submit" disabled={!question.trim() || loading} aria-label="Send question" className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-teal text-white disabled:opacity-40">{loading ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}</button>
        </div>
        <p className="mt-2 text-center text-[11px] text-slate-400">Enter to send · Shift+Enter for a new line</p>
      </form>
    </section>
  );
}
