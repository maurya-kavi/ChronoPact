import { Router } from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { enqueuePolicyIngestion, retryPolicyIngestion } from "../services/policyIngestionWorker";
import { deletePolicyFromQdrant, upsertPolicyToQdrant } from "../services/ragService";
import { requireHrAdmin } from "../middleware/hrAdminAccess";
import { answerPolicyQuestion } from "../services/policyChatService";

export const policiesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

policiesRouter.post("/api/policies/chat", requireHrAdmin, async (request, response, next) => {
  try {
    const parsed = z.object({
      question: z.string().trim().min(1).max(4000),
      documentName: z.string().trim().optional(),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(20).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid policy chat request", details: parsed.error.flatten() });
    response.json(await answerPolicyQuestion(parsed.data));
  } catch (error) {
    next(error);
  }
});

policiesRouter.post("/api/policies/upload", upload.single("file"), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: "Policy file is required" });
    if (!/\.(pdf|docx|txt|md|csv)$/i.test(request.file.originalname)) {
      return response.status(400).json({ error: "Unsupported policy file. Upload a PDF, DOCX, TXT, MD, or CSV file." });
    }
    const region = z.enum(["ALL", "IN", "US"]).parse(request.body.region ?? "ALL");
    await fs.mkdir(path.join(process.cwd(), "tmp_uploads"), { recursive: true });
    const document = await prisma.policyDocument.create({
      data: {
        fileName: request.file.originalname,
        mimeType: request.file.mimetype || "application/octet-stream",
        region,
        status: "QUEUED",
        progressPercent: 5,
        currentStep: "Queued for background processing",
        extractedPolicyCodesJson: [] as Prisma.InputJsonValue,
      },
    });
    await fs.writeFile(
      path.join(process.cwd(), "tmp_uploads", `${document.id}-${document.fileName}`),
      request.file.buffer,
    );
    enqueuePolicyIngestion(document.id);
    response.status(202).json({
      status: "QUEUED",
      document,
    });
  } catch (error) {
    next(error);
  }
});

policiesRouter.post("/api/policies/documents/:id/retry", async (request, response, next) => {
  try {
    const document = await prisma.policyDocument.findUnique({ where: { id: request.params.id } });
    if (!document) return response.status(404).json({ error: "Policy document not found" });
    if (document.status !== "FAILED") return response.status(409).json({ error: "Only FAILED documents can be retried" });
    const queued = await retryPolicyIngestion(document.id);
    response.status(202).json(queued);
  } catch (error) {
    next(error);
  }
});

policiesRouter.get("/api/policies/documents", async (_request, response, next) => {
  try {
    const documents = await prisma.policyDocument.findMany({ orderBy: { uploadedAt: "desc" } });
    response.json(documents);
  } catch (error) {
    next(error);
  }
});

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  category: z.enum(["PUNCH", "OVERTIME", "BREAK", "REST_GAP", "LEAVE", "SCHEDULE"]).optional(),
  region: z.enum(["ALL", "IN", "US"]).optional(),
  ruleText: z.string().min(10).optional(),
  thresholdJson: z.record(z.unknown()).optional(),
});

policiesRouter.patch("/api/policies/:id", async (request, response, next) => {
  try {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid policy update", details: parsed.error.flatten() });
    const existing = await prisma.policyRule.findUnique({ where: { id: request.params.id } });
    if (!existing) return response.status(404).json({ error: "Policy rule not found" });

    const updated = await prisma.policyRule.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
        ...(parsed.data.region !== undefined ? { region: parsed.data.region } : {}),
        ...(parsed.data.ruleText !== undefined ? { ruleText: parsed.data.ruleText } : {}),
        ...(parsed.data.thresholdJson !== undefined
          ? { thresholdJson: parsed.data.thresholdJson as Prisma.InputJsonObject }
          : {}),
      },
    });
    await upsertPolicyToQdrant(updated);
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

policiesRouter.delete("/api/policies/:id", async (request, response, next) => {
  try {
    const existing = await prisma.policyRule.findUnique({ where: { id: request.params.id } });
    if (!existing) return response.status(404).json({ error: "Policy rule not found" });
    await deletePolicyFromQdrant(existing.id);
    await prisma.policyRule.delete({ where: { id: existing.id } });
    response.json({ status: "DELETED", policyCode: existing.policyCode, qdrantSync: "updated" });
  } catch (error) {
    next(error);
  }
});
