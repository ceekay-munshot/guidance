// pdf.mjs — extract text from a PDF byte buffer with pdfjs-dist (legacy build, runs in Node).

/**
 * Extract text from a PDF. `data` is a Uint8Array/Buffer of the PDF bytes.
 * Returns the concatenated page text (pages separated by blank lines).
 * Throws on an unparseable PDF — callers catch and fall back / flag.
 */
export async function extractPdfText(data) {
  // Imported lazily so the module loads even before the no-save install runs.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // No worker in Node — pdfjs runs on the main thread (fake worker).
  const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const doc = await loadingTask.promise;

  const parts = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Rebuild rough line breaks: pdfjs marks end-of-line items with hasEOL.
      let line = [];
      const pageText = [];
      for (const item of content.items) {
        if (typeof item.str === "string") line.push(item.str);
        if (item.hasEOL) { pageText.push(line.join("")); line = []; }
      }
      if (line.length) pageText.push(line.join(""));
      parts.push(pageText.join("\n"));
      if (typeof page.cleanup === "function") page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return parts.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
