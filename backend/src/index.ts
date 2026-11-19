import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { employeeRouter } from "./routes/employeeRoutes";
import { hrRouter } from "./routes/hrRoutes";
import { prisma } from "./lib/prisma";
import { syncAllPoliciesToQdrant } from "./services/ragService";

export const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_request: Request, response: Response) => {
  response.json({
    status: "ok",
    service: "chronopact-backend",
    timestamp: new Date().toISOString(),
  });
});

const openapiDocument = YAML.load(`${process.cwd()}/openapi.yaml`);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));
app.use(employeeRouter);
app.use(hrRouter);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: error.message });
  }
  console.error(error);
  return response.status(500).json({
    error: error instanceof Error ? error.message : "Internal server error",
  });
});

const port = Number(process.env.PORT ?? 4000);

async function start(): Promise<void> {
  void syncAllPoliciesToQdrant()
    .then((result) => {
      console.log(`Startup policy Qdrant sync: ${result.synced} policies, available=${result.available}`);
    })
    .catch((error) => {
      console.warn("Startup policy sync fell back to PostgreSQL:", error instanceof Error ? error.message : error);
    });

  app.listen(port, () => {
    console.log(`ChronoPact backend listening on http://localhost:${port}`);
  });
}

void start();
