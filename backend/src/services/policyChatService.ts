import OpenAI from "openai";
import { retrievePolicyChatContext } from "./ragService";

export const NO_POLICY_ANSWER = "I could not find an answer to this in the uploaded policy documents indexed in Qdrant.";

export interface PolicyChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export async function answerPolicyQuestion(input: {
  question: string;
  documentName?: string;
  history?: PolicyChatHistoryItem[];
}): Promise<{
  answer: string;
  citations: Array<{ documentName: string; policyCode: string | null; snippet: string; score: number }>;
  modelUsed: string;
  qdrantChunksSearched: number;
  retrievalSource: "QDRANT" | "POSTGRES_FALLBACK";
}> {
  const retrieval = await retrievePolicyChatContext(input.question, input.documentName);
  const citations = retrieval.contexts.map((context) => ({
    documentName: context.documentName,
    policyCode: context.policyCode,
    snippet: context.chunkText,
    score: Math.max(0, Math.min(1, context.score)),
  }));
  const primaryModel = "openai/gpt-oss-120b";
  const fallbackModel = "openai/gpt-oss-20b";
  if (!retrieval.contexts.length) {
    return {
      answer: NO_POLICY_ANSWER,
      citations: [],
      modelUsed: primaryModel,
      qdrantChunksSearched: retrieval.qdrantChunksSearched,
      retrievalSource: retrieval.usedPostgresFallback ? "POSTGRES_FALLBACK" : "QDRANT",
    };
  }
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured");

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  });
  const contextBlock = retrieval.contexts.map((context, index) => [
    `SOURCE ${index + 1}`,
    `documentName: ${context.documentName}`,
    `policyCode: ${context.policyCode ?? "Not specified"}`,
    `chunkText: ${context.chunkText}`,
  ].join("\n")).join("\n\n---\n\n");
  const messages = [
    {
      role: "system" as const,
      content: [
        "You are an HR policy assistant. Answer only with facts explicitly stated in the supplied retrieved policy context.",
        "The retrieved context is the only policy source. Do not use general knowledge, assumptions, or conversation history as evidence.",
        "Cite exact source document names inline and cite the exact policy code in square brackets when one is provided, such as [POL-OT-01].",
        `If the context does not contain the answer, respond exactly: ${NO_POLICY_ANSWER}`,
        "Retrieved policy context:",
        contextBlock,
      ].join("\n\n"),
    },
    ...(input.history ?? []).slice(-10).map((item) => ({ role: item.role, content: item.content })),
    { role: "user" as const, content: input.question },
  ];

  let modelUsed = primaryModel;
  let answer: string;
  try {
    const completion = await client.chat.completions.create({ model: primaryModel, temperature: 0, messages });
    answer = completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    const candidate = error as { status?: number; message?: string; error?: { message?: string } };
    const rateLimited = candidate.status === 429 || /429|rate limit|tpm/i.test(candidate.error?.message ?? candidate.message ?? "");
    if (!rateLimited) throw error;
    modelUsed = fallbackModel;
    const completion = await client.chat.completions.create({ model: fallbackModel, temperature: 0, messages });
    answer = completion.choices[0]?.message?.content?.trim() ?? "";
  }

  if (!answer) answer = NO_POLICY_ANSWER;
  return {
    answer,
    citations,
    modelUsed,
    qdrantChunksSearched: retrieval.qdrantChunksSearched,
    retrievalSource: retrieval.usedPostgresFallback ? "POSTGRES_FALLBACK" : "QDRANT",
  };
}
