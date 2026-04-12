const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function commandExists(command) {
  return new Promise((resolve) => {
    execFile("which", [command], (error, stdout) => {
      resolve(!error && Boolean(String(stdout || "").trim()));
    });
  });
}

async function getOCRAvailability() {
  const [pdftoppm, tesseract] = await Promise.all([
    commandExists("pdftoppm"),
    commandExists("tesseract")
  ]);

  return {
    available: pdftoppm && tesseract,
    pdftoppm,
    tesseract
  };
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function countWords(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function looksLikeWeakPDFExtraction(text, metadata = {}) {
  const value = normalizeExtractedText(text);
  if (!value) return true;

  const pages = Math.max(1, Number(metadata.pages || 1));
  const words = countWords(value);
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  const avgWordsPerPage = words / pages;
  const avgLineLength = lines.length
    ? lines.reduce((sum, line) => sum + line.trim().length, 0) / lines.length
    : 0;
  const alphaChars = (value.match(/[A-Za-z]/g) || []).length;
  const textishChars = (value.match(/[A-Za-z0-9]/g) || []).length;
  const alphaRatio = textishChars ? alphaChars / textishChars : 0;
  const replacementCount = (value.match(/\uFFFD/g) || []).length;

  if (avgWordsPerPage < 16) return true;
  if (avgLineLength < 18 && lines.length > 8) return true;
  if (alphaRatio < 0.45) return true;
  if (replacementCount >= 4) return true;
  return false;
}

async function extractTextFromPDFWithOCR(buffer, opts = {}) {
  const availability = await getOCRAvailability();
  if (!availability.available) {
    return {
      text: "",
      metadata: {
        method: "ocr_unavailable",
        availability
      }
    };
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "socratic-ocr-"));
  const pdfPath = path.join(tmpDir, "document.pdf");
  const imagePrefix = path.join(tmpDir, "page");
  const maxPages = Math.max(1, Number(opts.maxPages || process.env.PDF_OCR_MAX_PAGES || 12));

  try {
    await fs.promises.writeFile(pdfPath, buffer);

    await execFileAsync("pdftoppm", [
      "-png",
      "-f",
      "1",
      "-l",
      String(maxPages),
      pdfPath,
      imagePrefix
    ]);

    const files = (await fs.promises.readdir(tmpDir))
      .filter((file) => file.startsWith("page-") && file.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const pageTexts = [];

    for (const file of files) {
      const imagePath = path.join(tmpDir, file);
      const { stdout } = await execFileAsync("tesseract", [
        imagePath,
        "stdout",
        "--psm",
        "6"
      ], {
        maxBuffer: 16 * 1024 * 1024
      });

      const text = normalizeExtractedText(stdout);
      if (text) {
        const pageNumberMatch = file.match(/page-(\d+)/);
        const pageNumber = pageNumberMatch ? Number(pageNumberMatch[1]) : pageTexts.length + 1;
        pageTexts.push(`[Page ${pageNumber}]\n${text}`);
      }
    }

    return {
      text: pageTexts.join("\n\n"),
      metadata: {
        method: "ocr",
        pagesProcessed: files.length,
        availability
      }
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  getOCRAvailability,
  looksLikeWeakPDFExtraction,
  extractTextFromPDFWithOCR
};
