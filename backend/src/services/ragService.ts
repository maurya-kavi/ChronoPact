import { QdrantClient } from "@qdrant/js-client-rest";
import { PolicyRule, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";

const collectionName = "chronopact_policies";
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

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
    if (!collections.collections?.some((item) => item.name === collectionName)) {
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
    return true;
  } catch (error) {
    console.warn("Qdrant unavailable; policy retrieval will use PostgreSQL fallback:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function syncAllPoliciesToQdrant(): Promise<{ synced: number; available: boolean }> {
  const available = await ensurePolicyCollection();
  if (!available) return { synced: 0, available: false };

  const policies = await prisma.policyRule.findMany();
  for (const policy of policies) {
    const pointId = policy.qdrantPointId || randomUUID();
    const vector = await embedText(`${policy.title}. ${policy.ruleText}`);
    await qdrant.upsert(collectionName, {
      points: [{
        id: pointId,
        vector,
        payload: {
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
