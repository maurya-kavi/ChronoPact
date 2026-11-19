import { PolicyCategory, Prisma } from "@prisma/client";
import { z } from "zod";
import OpenAI from "openai";
import { prisma } from "../lib/prisma";
import { syncAllPoliciesToQdrant } from "./ragService";

const ExtractedRuleSchema = z.object({
  policyCode: z.string().regex(/^POL-[A-Z]+-\d{2}$/),
  title: z.string().min(2),
  category: z.enum(["PUNCH", "OVERTIME", "BREAK", "REST_GAP", "LEAVE", "SCHEDULE"]),
  region: z.enum(["ALL", "IN", "US"]),
  ruleText: z.string().min(10),
  thresholdJson: z.record(z.unknown()),
});
const ExtractedRulesSchema = z.array(ExtractedRuleSchema).min(1);

function isPlainText(filename: string): boolean {
  return /\.(txt|md)$/i.test(filename);
}

async function extractMarkdown(fileBuffer: Buffer, filename: string): Promise<string> {
  if (isPlainText(filename)) return fileBuffer.toString("utf8").trim();

  const baseUrl = (process.env.DOCLING_SERVICE_URL ?? "http://localhost:8001").replace(/\/$/, "");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(fileBuffer)]), filename);
  const response = await fetch(`${baseUrl}/parse`, { method: "POST", body: form });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Docling extraction failed (${response.status}): ${body}`);
  }
  const result = await response.json() as { markdownText?: string; markdown?: string };
  const markdown = result.markdownText ?? result.markdown;
  if (!markdown?.trim()) throw new Error("Docling extracted an empty document");
  return markdown.trim();
}

export async function ingestPolicyDocument(
  fileBuffer: Buffer,
  originalFilename: string,
  defaultRegion: "ALL" | "IN" | "US",
): Promise<{ rules: Awaited<ReturnType<typeof prisma.policyRule.findMany>>; markdownCharacters: number }> {
  const markdown = await extractMarkdown(fileBuffer, originalFilename);

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "not-configured",
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  });

  let lastError: unknown;
  let parsed: z.infer<typeof ExtractedRulesSchema> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const retryInstruction = lastError ? `\nThe previous result failed validation: ${String(lastError)}. Return only corrected valid JSON.` : "";
    const response = await client.chat.completions.create({
      model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract attendance and labor policy rules. Default region is ${defaultRegion}. Return a JSON object with a "rules" array matching the requested fields. Each rule needs a unique POL-* code. No policy invention beyond the document.`,
        },
        { role: "user", content: `${retryInstruction}\n\nDocument Markdown:\n${markdown}` },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    try {
      const envelope = JSON.parse(raw);
      const candidate = Array.isArray(envelope) ? envelope : envelope.rules;
      parsed = ExtractedRulesSchema.parse(candidate);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed) throw new Error(`Policy extraction failed Zod validation after retries: ${String(lastError)}`);

  for (const rule of parsed) {
    await prisma.policyRule.upsert({
      where: { policyCode: rule.policyCode },
      create: {
        policyCode: rule.policyCode,
        title: rule.title,
        category: rule.category as PolicyCategory,
        region: rule.region,
        ruleText: rule.ruleText,
        thresholdJson: rule.thresholdJson as Prisma.InputJsonObject,
      },
      update: {
        title: rule.title,
        category: rule.category as PolicyCategory,
        region: rule.region,
        ruleText: rule.ruleText,
        thresholdJson: rule.thresholdJson as Prisma.InputJsonObject,
        qdrantPointId: null,
      },
    });
  }

  await syncAllPoliciesToQdrant();
  const policyCodes = parsed.map((rule) => rule.policyCode);
  const rules = await prisma.policyRule.findMany({ where: { policyCode: { in: policyCodes } } });
  return { rules, markdownCharacters: markdown.length };
}






