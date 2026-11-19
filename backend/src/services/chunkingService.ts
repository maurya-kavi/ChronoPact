export interface PolicyChunkInput {
  chunkIndex: number;
  sectionTitle: string;
  chunkText: string;
  tokenEstimate: number;
}

export function splitMarkdownIntoChunks(
  text: string,
  options: { chunkSize?: number; overlap?: number } = {},
): PolicyChunkInput[] {
  const chunkSize = options.chunkSize ?? 1800;
  const overlap = Math.max(0, Math.min(options.overlap ?? 300, chunkSize - 1));
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const segments: Array<{ text: string; heading: string }> = [];
  let heading = "General Policy";
  let paragraphBuffer = "";
  for (const line of normalized.split("\n")) {
    const headingMatch = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (headingMatch) {
      if (paragraphBuffer.trim()) segments.push({ text: paragraphBuffer.trim(), heading });
      heading = headingMatch[1];
      paragraphBuffer = `${line}\n`;
    } else {
      paragraphBuffer += `${line}\n`;
      if (line.trim() === "" && paragraphBuffer.trim().length >= chunkSize * 0.6) {
        segments.push({ text: paragraphBuffer.trim(), heading });
        paragraphBuffer = "";
      }
    }
  }
  if (paragraphBuffer.trim()) segments.push({ text: paragraphBuffer.trim(), heading });

  const windows: Array<{ text: string; heading: string }> = [];
  for (const segment of segments) {
    if (segment.text.length <= chunkSize) {
      windows.push(segment);
      continue;
    }
    for (let start = 0; start < segment.text.length; start += chunkSize - overlap) {
      const slice = segment.text.slice(start, start + chunkSize).trim();
      if (slice) windows.push({ text: slice, heading: segment.heading });
      if (start + chunkSize >= segment.text.length) break;
    }
  }

  return windows.map((chunk, chunkIndex) => ({
    chunkIndex,
    sectionTitle: chunk.heading,
    chunkText: chunk.text,
    tokenEstimate: Math.ceil(chunk.text.length / 4),
  }));
}
