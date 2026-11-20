import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import { Prisma, PolicyCategory } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { splitMarkdownIntoChunks } from "./chunkingService";
import { embedText, ensurePolicyCollection, toValidQdrantUuid } from "./ragService";
import { QdrantClient } from "@qdrant/js-client-rest";

const collectionName = "chronopact_policies";
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

const jobQueue: string[] = [];
const resumeRawTextJobs = new Set<string>();
let activeWorkers = 0;
const concurrency = 2;

function csvToReadableMarkdown(csv: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") index++;
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV policy must contain a header row and at least one data row");

  const headers = rows[0].map((header, index) => header || `Column ${index + 1}`);
  return [
    "# Policy Data (CSV)",
    `Columns: ${headers.join(" | ")}`,
    ...rows.slice(1).map((values, rowIndex) => {
      const fields = headers.map((header, columnIndex) => {
        const value = (values[columnIndex] ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
        return `${header}: ${value || "(blank)"}`;
      });
      return `## Row ${rowIndex + 1}\n${fields.map((field) => `- ${field}`).join("\n")}`;
    }),
  ].join("\n\n");
}

const ExtractedRuleSchema = z.object({
  policyCode: z.string().optional(),
  title: z.string().optional().default("Imported Policy Rule"),
  category: z.string().optional().default("PUNCH"),
  region: z.enum(["ALL", "IN", "US"]).optional(),
  ruleText: z.string().optional().default("Policy rule extracted from uploaded document."),
  thresholdJson: z.record(z.unknown()).optional().default({}),
});

async function updateDocument(documentId: string, data: Prisma.PolicyDocumentUncheckedUpdateInput) {
  await prisma.policyDocument.update({ where: { id: documentId }, data });
}

async function extractMarkdown(document: { id: string; fileName: string; mimeType: string; rawExtractedText: string | null }): Promise<string> {
  if (document.rawExtractedText?.trim()) return document.rawExtractedText.trim();
  if (/\.csv$/i.test(document.fileName)) {
    const filePath = path.join(process.cwd(), "tmp_uploads", `${document.id}-${document.fileName}`);
    const buffer = await fs.readFile(filePath);
    return csvToReadableMarkdown(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  }
  if (/\.txt$/i.test(document.fileName) || /\.md$/i.test(document.fileName)) {
    const filePath = path.join(process.cwd(), "tmp_uploads", `${document.id}-${document.fileName}`);
    const buffer = await fs.readFile(filePath);
    return buffer.toString("utf8").trim();
  }
  const filePath = path.join(process.cwd(), "tmp_uploads", `${document.id}-${document.fileName}`);
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(buffer)], { type: document.mimeType }), document.fileName);
  const baseUrl = (process.env.DOCLING_SERVICE_URL ?? "http://localhost:8001").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/parse`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Docling extraction failed (${response.status}): ${await response.text()}`);
  const result = await response.json() as { markdownText?: string; markdown?: string };
  const markdown = (result.markdownText ?? result.markdown ?? "").trim();
  if (!markdown) throw new Error("Docling extracted an empty document");
  return markdown;
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeCategory(value: string): "PUNCH" | "OVERTIME" | "BREAK" | "REST_GAP" | "LEAVE" | "SCHEDULE" {
  const normalized = value.trim().toUpperCase();
  if (normalized === "SHIFT" || normalized === "SCHEDULE") return "SCHEDULE";
  if (normalized === "UNDERTIME" || normalized === "OVERTIME") return "OVERTIME";
  if (normalized === "BREAK") return "BREAK";
  if (normalized === "REST_GAP" || normalized === "REST") return "REST_GAP";
  if (normalized === "LEAVE") return "LEAVE";
  return "PUNCH";
}

function extractErrorMessage(error: unknown): string {
  const candidate = error as {
    error?: { message?: unknown };
    response?: { data?: unknown };
    data?: unknown;
    message?: unknown;
  };
  const values = [candidate?.error?.message, candidate?.response?.data, candidate?.data, candidate?.message];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        // Continue to the next available error source.
      }
    }
  }
  return "Policy ingestion failed";
}

async function extractRulesBatch(markdown: string, region: "ALL" | "IN" | "US"): Promise<z.infer<typeof ExtractedRuleSchema>[]> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  });
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `Return a valid JSON object. The JSON must contain a single key "rules" whose value is an array. Extract up to 2 concise attendance, shift, leave, break, overtime, undertime, rest, punch, or schedule rules for region ${region}. Object shape: {"rules":[{"policyCode":"POL-...","title":"...","category":"SHIFT|LEAVE|BREAK|OVERTIME|UNDERTIME|PUNCH|REST_GAP|SCHEDULE","region":"ALL|IN|US","ruleText":"...","thresholdJson":{}}]}. If there are no applicable rules, return {"rules":[]}. Keep prompt content under 2200 tokens.` },
          { role: "user", content: `Analyze the following document text and return JSON only. Explicitly use the word JSON and return {"rules":[]} if it contains no attendance or shift rules.\n\n${markdown.slice(0, 6500)}` },
        ],
      });
      const envelope = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      const candidate = Array.isArray(envelope) ? envelope : envelope.rules;
      return z.array(ExtractedRuleSchema).max(2).parse(candidate ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|413|rate|too large/i.test(message) || attempt === 4) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  return [];
}

async function runJob(documentId: string, resumeFromRawText = false) {
  let tempFilePath: string | undefined;
  try {
    const document = await prisma.policyDocument.findUnique({ where: { id: documentId } });
    if (!document) return;
    let markdown = document.rawExtractedText?.trim() ?? "";
    if (!resumeFromRawText || !markdown) {
      await updateDocument(documentId, { status: "EXTRACTING", progressPercent: 20, currentStep: "Extracting document text", errorMessage: null });
      markdown = await extractMarkdown(document);
    } else {
      await updateDocument(documentId, { status: "CHUNKING", progressPercent: 40, currentStep: "Chunking policy sections", processedChunks: 0, errorMessage: null });
    }
    await updateDocument(documentId, { rawExtractedText: markdown, status: "CHUNKING", progressPercent: 40, currentStep: "Chunking policy sections" });
    await prisma.policyChunk.deleteMany({ where: { documentId } });

    const chunks = splitMarkdownIntoChunks(markdown, { chunkSize: 1800, overlap: 300 });
    await updateDocument(documentId, { totalChunks: chunks.length, processedChunks: 0 });
    await prisma.policyChunk.createMany({
      data: chunks.map((chunk) => ({
        documentId,
        chunkIndex: chunk.chunkIndex,
        sectionTitle: chunk.sectionTitle,
        chunkText: chunk.chunkText,
        region: document.region,
        tokenEstimate: chunk.tokenEstimate,
      })),
    });

    await updateDocument(documentId, { status: "EMBEDDING", progressPercent: 65, currentStep: "Embedding policy chunks" });
    await ensurePolicyCollection();
    const persistedChunks = await prisma.policyChunk.findMany({ where: { documentId }, orderBy: { chunkIndex: "asc" } });
    for (let i = 0; i < persistedChunks.length; i++) {
      const chunk = persistedChunks[i];
      const vector = await embedText(chunk.chunkText);
      await qdrant.upsert(collectionName, {
        points: [{
          id: toValidQdrantUuid(chunk.id),
          vector,
          payload: {
            kind: "POLICY_CHUNK",
            chunkId: chunk.id,
            documentId,
            documentName: document.fileName,
            fileName: document.fileName,
            policyCode: null,
            region: document.region,
            chunkIndex: chunk.chunkIndex,
            sectionTitle: chunk.sectionTitle,
            chunkText: chunk.chunkText,
          },
        }],
      });
      await updateDocument(documentId, { processedChunks: i + 1 });
    }

    await updateDocument(documentId, { status: "EXTRACTING_RULES", progressPercent: 85, currentStep: "Extracting structured policy rules" });
    const policyCodes = new Set<string>();
    const batches = persistedChunks.length ? persistedChunks : [];
    for (let i = 0; i < batches.length; i += 2) {
      const batch = batches.slice(i, i + 2);
      const batchPolicyCodes: string[] = [];
      const extracted = await extractRulesBatch(
        batch.map((chunk) => `## ${chunk.sectionTitle}\n${chunk.chunkText}`).join("\n\n").slice(0, 6500),
        document.region as "ALL" | "IN" | "US",
      );
      for (const rule of extracted) {
        const category = normalizeCategory(rule.category);
        const region = rule.region === "ALL" || rule.region === "IN" || rule.region === "US" ? rule.region : document.region;
        const policyCode = rule.policyCode?.match(/^POL-[A-Z]+-\d{2}$/)
          ? rule.policyCode
          : `POL-DOC-${String(policyCodes.size + 1).padStart(2, "0")}`;
        await prisma.policyRule.upsert({
          where: { policyCode },
          create: {
            policyCode,
            title: rule.title,
            category: category as PolicyCategory,
            region,
            ruleText: rule.ruleText,
            thresholdJson: rule.thresholdJson as Prisma.InputJsonObject,
          },
          update: {
            title: rule.title,
            category: category as PolicyCategory,
            region,
            ruleText: rule.ruleText,
            thresholdJson: rule.thresholdJson as Prisma.InputJsonObject,
          },
        });
        const policy = await prisma.policyRule.findUnique({ where: { policyCode } });
        if (policy) {
          const vector = await embedText(`${policy.title}. ${policy.ruleText}`);
          const pointId = toValidQdrantUuid(policy.qdrantPointId ?? policy.id);
          await qdrant.upsert(collectionName, {
            points: [{
              id: pointId,
              vector,
              payload: { kind: "POLICY_RULE", policyId: policy.id, policyCode: policy.policyCode, documentId, documentName: document.fileName, title: policy.title, category: policy.category, region: policy.region, ruleText: policy.ruleText },
            }],
          });
          await prisma.policyRule.update({ where: { id: policy.id }, data: { qdrantPointId: pointId } });
        }
        policyCodes.add(policyCode);
        batchPolicyCodes.push(policyCode);
      }
      if (batchPolicyCodes.length) {
        await qdrant.setPayload(collectionName, {
          payload: { policyCode: batchPolicyCodes[0] },
          points: batch.map((chunk) => toValidQdrantUuid(chunk.id)),
        });
      }
      await updateDocument(documentId, { processedChunks: Math.min(persistedChunks.length, i + 2) });
      await sleep(1500);
    }

    await updateDocument(documentId, {
      status: "DONE",
      progressPercent: 100,
      currentStep: "Completed: Indexed chunks and extracted rules",
      extractedCount: policyCodes.size,
      extractedPolicyCodesJson: [...policyCodes] as Prisma.InputJsonValue,
      errorMessage: null,
    });
  } catch (error) {
    console.error("Policy ingestion worker error", { documentId, error });
    const message = extractErrorMessage(error);
    await updateDocument(documentId, { status: "FAILED", errorMessage: message, currentStep: "Failed background ingestion" }).catch(() => undefined);
  } finally {
    const document = await prisma.policyDocument.findUnique({ where: { id: documentId } }).catch(() => null);
    if (document) {
      tempFilePath = path.join(process.cwd(), "tmp_uploads", `${documentId}-${document.fileName}`);
      await fs.unlink(tempFilePath).catch(() => undefined);
    }
  }
}

async function drainQueue() {
  if (activeWorkers >= concurrency) return;
  const documentId = jobQueue.shift();
  if (!documentId) return;
  activeWorkers++;
  try {
    const resumeFromRawText = resumeRawTextJobs.delete(documentId);
    await runJob(documentId, resumeFromRawText);
  } finally {
    activeWorkers--;
    void drainQueue();
  }
  void drainQueue();
}

export function enqueuePolicyIngestion(documentId: string) {
  jobQueue.push(documentId);
  void drainQueue();
}

export function enqueuePolicyIngestionRetry(documentId: string) {
  resumeRawTextJobs.add(documentId);
  jobQueue.push(documentId);
  void drainQueue();
}

export async function retryPolicyIngestion(documentId: string) {
  await updateDocument(documentId, {
    status: "CHUNKING",
    progressPercent: 40,
    currentStep: "Retrying from saved extracted text",
    processedChunks: 0,
    errorMessage: null,
  });
  enqueuePolicyIngestionRetry(documentId);
  return prisma.policyDocument.findUnique({ where: { id: documentId } });
}
