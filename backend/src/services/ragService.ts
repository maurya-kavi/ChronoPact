import { QdrantClient } from "@qdrant/js-client-rest";
import { PolicyRule, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { prisma } from "../lib/prisma";

const collectionName = "chronopact_policies";
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

export function toValidQdrantUuid(rawId: string): string {
  const h = createHash("sha256").update(rawId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

let extractorPromise: Promise<any> | undefined;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = import("@xenova/transformers").then(({ pipeline }) =>
      pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2"),
    );
  }
  return extractorPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const vector = Array.from(output.data as ArrayLike<number>);
  if (vector.length !== 384) throw new Error(`Embedding dimension was ${vector.length}; expected 384`);
  return vector;
}

export async function ensurePolicyCollection(): Promise<boolean> {
  try {
    const collections = await qdrant.getCollections();
    const exists = collections.collections?.some((item) => item.name === collectionName);
    if (exists) {
      const info = await qdrant.getCollection(collectionName);
      const vectors = (info.config?.params as unknown as { vectors?: { size?: number } | number })?.vectors;
      const size = typeof vectors === "object" ? vectors?.size : undefined;
      if (size !== 384) {
        await qdrant.deleteCollection(collectionName);
        await qdrant.createCollection(collectionName, {
          vectors: { size: 384, distance: "Cosine" },
        });
      }
    } else {
      await qdrant.createCollection(collectionName, {
        vectors: { size: 384, distance: "Cosine" },
      });
    }
    await qdrant.createPayloadIndex(collectionName, {
      field_name: "region",
      field_schema: "keyword",
    }).catch(() => undefined);
    await qdrant.createPayloadIndex(collectionName, {
      field_name: "category",
      field_schema: "keyword",
    }).catch(() => undefined);
    await qdrant.createPayloadIndex(collectionName, {
      field_name: "kind",
      field_schema: "keyword",
    }).catch(() => undefined);
    await qdrant.createPayloadIndex(collectionName, {
      field_name: "documentName",
      field_schema: "keyword",
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.warn("Qdrant unavailable; policy retrieval will use PostgreSQL fallback:", error instanceof Error ? error.message : error);
    return false;
  }
}

export interface PolicyChatContext {
  documentName: string;
  policyCode: string | null;
  chunkText: string;
  score: number;
}

const stopWords = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "does", "are", "is", "how", "can", "will", "into", "during", "before", "after"]);

function keywordScore(query: string, text: string): number {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((term) => !stopWords.has(term));
  if (!terms.length) return 0;
  const normalized = text.toLowerCase();
  const matched = terms.filter((term) => normalized.includes(term)).length;
  return matched / terms.length;
}

export async function retrievePolicyChatContext(question: string, documentName?: string): Promise<{
  contexts: PolicyChatContext[];
  qdrantChunksSearched: number;
  usedPostgresFallback: boolean;
}> {
  try {
    const available = await ensurePolicyCollection();
    if (!available) throw new Error("Qdrant collection is unavailable");
    const vector = await embedText(question);
    const filter: { must: Array<Record<string, unknown>>; should?: Array<Record<string, unknown>> } = {
      must: [{ key: "kind", match: { value: "POLICY_CHUNK" } }],
    };
    if (documentName && documentName !== "ALL") filter.should = [
      { key: "documentName", match: { value: documentName } },
      { key: "fileName", match: { value: documentName } },
    ];
    const result = await qdrant.query(collectionName, {
      query: vector,
      limit: 6,
      with_payload: true,
      filter: filter as never,
    });
    const contexts = (result.points ?? []).map((point) => ({
      documentName: String(point.payload?.documentName ?? point.payload?.fileName ?? "Uploaded policy document"),
      policyCode: typeof point.payload?.policyCode === "string" ? point.payload.policyCode : null,
      chunkText: String(point.payload?.chunkText ?? ""),
      score: Number(point.score ?? 0),
    })).filter((context) => context.chunkText.trim());
    return { contexts, qdrantChunksSearched: contexts.length, usedPostgresFallback: false };
  } catch (error) {
    console.warn("Qdrant policy chat retrieval failed; using PostgreSQL policy rules:", error instanceof Error ? error.message : error);
  }

  const documents = await prisma.policyDocument.findMany({
    select: { fileName: true, extractedPolicyCodesJson: true },
  });
  const policyDocuments = new Map<string, string>();
  for (const document of documents) {
    if (documentName && documentName !== "ALL" && document.fileName !== documentName) continue;
    const codes = Array.isArray(document.extractedPolicyCodesJson)
      ? document.extractedPolicyCodesJson.filter((code): code is string => typeof code === "string")
      : [];
    for (const code of codes) policyDocuments.set(code, document.fileName);
  }
  const policies = await prisma.policyRule.findMany();
  const contexts = policies.map((policy) => ({
    policy,
    score: keywordScore(question, `${policy.policyCode} ${policy.title} ${policy.ruleText}`),
    documentName: policyDocuments.get(policy.policyCode),
  })).filter((item) => item.score > 0 && item.documentName)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ policy, score, documentName: sourceDocument }) => ({
      documentName: sourceDocument as string,
      policyCode: policy.policyCode,
      chunkText: `${policy.title}: ${policy.ruleText}`,
      score,
    }));
  return { contexts, qdrantChunksSearched: 0, usedPostgresFallback: true };
}

export async function syncAllPoliciesToQdrant(): Promise<{ synced: number; available: boolean }> {
  const available = await ensurePolicyCollection();
  if (!available) return { synced: 0, available: false };

  const policies = await prisma.policyRule.findMany();
  for (const policy of policies) {
    const pointId = toValidQdrantUuid(policy.qdrantPointId || policy.id || randomUUID());
    const vector = await embedText(`${policy.title}. ${policy.ruleText}`);
    await qdrant.upsert(collectionName, {
      points: [{
        id: pointId,
        vector,
        payload: {
          policyId: policy.id,
          policyCode: policy.policyCode,
          title: policy.title,
          category: policy.category,
          region: policy.region,
          ruleText: policy.ruleText,
        },
      }],
    });
    if (!policy.qdrantPointId) {
      await prisma.policyRule.update({
        where: { id: policy.id },
        data: { qdrantPointId: pointId },
      });
    }

  }
  return { synced: policies.length, available: true };
}

export async function upsertPolicyToQdrant(policy: PolicyRule): Promise<boolean> {
  try {
    await ensurePolicyCollection();
    const pointId = toValidQdrantUuid(policy.qdrantPointId || policy.id || randomUUID());
    const vector = await embedText(`${policy.title}. ${policy.ruleText}`);
    await qdrant.upsert(collectionName, {
      points: [{
        id: pointId,
        vector,
        payload: {
          policyId: policy.id,
          policyCode: policy.policyCode,
          title: policy.title,
          category: policy.category,
          region: policy.region,
          ruleText: policy.ruleText,
        },
      }],
    });
    if (!policy.qdrantPointId) {
      await prisma.policyRule.update({
        where: { id: policy.id },
        data: { qdrantPointId: pointId },
      });
    }
    return true;
  } catch (error) {
    console.warn("Could not upsert policy vector into Qdrant:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function deletePolicyFromQdrant(policyId: string): Promise<boolean> {
  try {
    const policy = await prisma.policyRule.findUnique({ where: { id: policyId } });
    if (!policy) return true;
    const rawPointId = policy.qdrantPointId || policy.id;
    await qdrant.delete(collectionName, {
      points: [toValidQdrantUuid(rawPointId)],
    });
    return true;
  } catch (error) {
    console.warn("Could not delete policy vector from Qdrant; continuing gracefully:", error instanceof Error ? error.message : error);
    return false;
  }
}

export interface RichPolicyContext {
  anomalyCode: string;
  region: string;
  employeeTeam: string;
  employeeDepartment: string;
  shiftStart: string;
  shiftEnd: string;
  rawDetails: Record<string, unknown>;
}

export async function retrieveRelevantPoliciesAndChunks(context: RichPolicyContext): Promise<{
  rules: PolicyRule[];
  chunks: Array<{ id: string; sectionTitle: string; chunkText: string; documentId: string }>;
}> {
    const query = [
      context.anomalyCode,
      context.employeeTeam,
      context.employeeDepartment,
      context.shiftStart,
      context.shiftEnd,
      JSON.stringify(context.rawDetails),
    ].join(" ");
    try {
      await ensurePolicyCollection();
      const vector = await embedText(query);
      const response = await qdrant.query(collectionName, {
        query: vector,
        limit: 6,
        with_payload: true,
        filter: { should: [{ key: "region", match: { any: [context.region, "ALL"] } }] },
      });
      const points = response.points ?? [];
      const ruleCodes = points
        .filter((point) => point.payload?.kind === "POLICY_RULE")
        .map((point) => String(point.payload?.policyCode ?? ""))
        .filter(Boolean);
      const rules = ruleCodes.length
        ? await prisma.policyRule.findMany({ where: { policyCode: { in: ruleCodes } }, take: 4 })
        : await prisma.policyRule.findMany({
            where: { region: { in: [context.region, "ALL"] } },
            take: 4,
          });
      const chunks = points
        .filter((point) => point.payload?.kind === "POLICY_CHUNK")
        .slice(0, 3)
        .map((point) => ({
          id: String(point.payload?.chunkId ?? point.id),
          sectionTitle: String(point.payload?.sectionTitle ?? "General Policy"),
          chunkText: String(point.payload?.chunkText ?? "").slice(0, 750),
          documentId: String(point.payload?.documentId ?? ""),
        }));
      if (chunks.length) return { rules, chunks };
    } catch (error) {
      console.warn("Rich Qdrant retrieval unavailable; using PostgreSQL fallback:", error instanceof Error ? error.message : error);
    }

    const [rules, chunks] = await Promise.all([
      prisma.policyRule.findMany({
        where: { region: { in: [context.region, "ALL"] } },
        take: 4,
      }),
      prisma.policyChunk.findMany({
        where: { region: { in: [context.region, "ALL"] } },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
    ]);
    return {
      rules,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        sectionTitle: chunk.sectionTitle,
        chunkText: chunk.chunkText.slice(0, 750),
        documentId: chunk.documentId,
      })),
    };
}

function inferCategory(anomalyCode: string): string | undefined {
  if (anomalyCode.includes("OVERTIME")) return "OVERTIME";
  if (anomalyCode.includes("BREAK")) return "BREAK";
  if (anomalyCode.includes("REST")) return "REST_GAP";
  if (anomalyCode.includes("LEAVE")) return "LEAVE";
  if (anomalyCode.includes("SHIFT") || anomalyCode.includes("SCHEDULE")) return "SCHEDULE";
  if (anomalyCode.includes("PUNCH") || anomalyCode.includes("CLOCK")) return "PUNCH";
  return undefined;
}

export async function retrieveRelevantPolicies(
  anomalyCode: string,
  anomalyDetails: Record<string, unknown>,
  employeeRegion: string,
  limit = 3,
): Promise<PolicyRule[]> {
  const category = inferCategory(anomalyCode);
  const should = [
    { key: "region", match: { any: [employeeRegion, "ALL"] } },
  ];
  if (category) should.push({ key: "category", match: { value: category } } as never);

  try {
    await ensurePolicyCollection();
    const query = `${anomalyCode}. ${JSON.stringify(anomalyDetails)}. ${category ?? "attendance policy"}`;
    const vector = await embedText(query);
    const response = await qdrant.query(collectionName, {
      query: vector,
      limit,
      with_payload: true,
      filter: { should },
    });
    const results = response.points ?? [];
    const codes = results
      .map((result) => String(result.payload?.policyCode ?? ""))
      .filter(Boolean);
    if (codes.length) {
      const found = await prisma.policyRule.findMany({ where: { policyCode: { in: codes } } });
      const byCode = new Map(found.map((policy) => [policy.policyCode, policy]));
      return codes.map((code) => byCode.get(code)).filter((policy): policy is PolicyRule => Boolean(policy)).slice(0, limit);
    }
  } catch (error) {
    console.warn("Vector retrieval unavailable; using PostgreSQL policy filter:", error instanceof Error ? error.message : error);
  }

  return prisma.policyRule.findMany({
    where: {
      region: { in: [employeeRegion, "ALL"] },
      ...(category ? { category: category as Prisma.EnumPolicyCategoryFilter["equals"] } : {}),
    },
    take: limit,
  });
}
