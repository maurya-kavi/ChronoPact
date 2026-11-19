export interface PolicyDocumentHistory {
  id: string;
  fileName: string;
  mimeType: string;
  region: "ALL" | "IN" | "US";
  status: "QUEUED" | "EXTRACTING" | "CHUNKING" | "EMBEDDING" | "EXTRACTING_RULES" | "DONE" | "FAILED";
  progressPercent: number;
  currentStep: string;
  totalChunks: number;
  processedChunks: number;
  errorMessage?: string | null;
  extractedCount: number;
  extractedPolicyCodesJson: string[];
  uploadedAt: string;
}
