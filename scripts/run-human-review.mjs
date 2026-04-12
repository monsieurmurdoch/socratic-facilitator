import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("dotenv").config();

const { MessageAssessor } = require("../server/analysis/messageAssessor");
const { runMessageAssessmentEval } = require("../server/analysis/evals/messageAssessmentEval");
const {
  buildChunksFromText,
  formatChunksForPrompt
} = require("../server/content/textGrounding");
const {
  getOCRAvailability,
  looksLikeWeakPDFExtraction
} = require("../server/content/ocr");
const contentExtractor = require("../server/content/extractor");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixtureDir = path.join(root, "tests", "review-fixtures");
const outputDir = path.join(root, "output", "review");

async function readTextFixture() {
  return fs.readFile(path.join(fixtureDir, "texts", "iliad-excerpt.txt"), "utf8");
}

async function maybeRunEval(strategy) {
  try {
    const assessor = new MessageAssessor(process.env.ANTHROPIC_API_KEY);
    const result = await runMessageAssessmentEval({
      assessor,
      strategy,
      allowHeuristicFallback: strategy === "auto"
    });

    return {
      strategy,
      completedCases: result.completedCases,
      totalCases: result.totalCases,
      failureCount: result.failureCount,
      availability: result.availability || null,
      metrics: result.metrics || null
    };
  } catch (error) {
    return {
      strategy,
      error: error.message
    };
  }
}

function metricLine(label, metric) {
  if (!metric) return `- ${label}: unavailable`;
  return `- ${label}: ${Object.entries(metric)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ")}`;
}

async function reviewPdfFixtures() {
  const pdfDir = path.join(fixtureDir, "pdfs");
  const entries = await fs.readdir(pdfDir, { withFileTypes: true });
  const pdfFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort();

  const results = [];

  for (const file of pdfFiles) {
    const filePath = path.join(pdfDir, file);
    const buffer = await fs.readFile(filePath);
    const extracted = await contentExtractor.extractPDF(buffer);
    const expectedPath = filePath.replace(/\.pdf$/i, ".expected.txt");

    let expected = null;
    try {
      expected = await fs.readFile(expectedPath, "utf8");
    } catch {}

    results.push({
      file,
      extractionMethod: extracted.metadata?.extractionMethod || "unknown",
      weakNative: looksLikeWeakPDFExtraction(extracted.text, extracted.metadata),
      preview: String(extracted.text || "").split(/\r?\n/).filter(Boolean).slice(0, 5).join("\n"),
      expectedWords: expected ? expected.split(/\s+/).filter(Boolean).length : null,
      extractedWords: String(extracted.text || "").split(/\s+/).filter(Boolean).length
    });
  }

  return results;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const [sourceText, ocrAvailability, heuristicEval, fastEval, smokeChecklist, pdfResults] = await Promise.all([
    readTextFixture(),
    getOCRAvailability(),
    maybeRunEval("heuristic_only"),
    maybeRunEval("fast_only"),
    fs.readFile(path.join(fixtureDir, "manual", "smoke-checklist.md"), "utf8"),
    reviewPdfFixtures()
  ]);

  const chunks = buildChunksFromText(sourceText, { maxLines: 4 });
  const groundingPreview = formatChunksForPrompt(chunks.slice(0, 2), "GROUNDING PREVIEW");

  const lines = [];
  lines.push("# Socratic Facilitator Human Review");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## OCR Environment");
  lines.push(`- pdftoppm: ${ocrAvailability.pdftoppm ? "available" : "missing"}`);
  lines.push(`- tesseract: ${ocrAvailability.tesseract ? "available" : "missing"}`);
  lines.push(`- OCR pipeline ready: ${ocrAvailability.available ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Text Grounding Preview");
  lines.push(`- fixture lines: ${sourceText.split(/\r?\n/).filter(Boolean).length}`);
  lines.push(`- generated chunks: ${chunks.length}`);
  lines.push("");
  lines.push("```text");
  lines.push(groundingPreview || "No grounding preview");
  lines.push("```");
  lines.push("");
  lines.push("## Message Assessment Benchmarks");
  lines.push(`- heuristic_only: ${heuristicEval.completedCases}/${heuristicEval.totalCases} completed, ${heuristicEval.failureCount} failures`);
  if (heuristicEval.metrics) {
    lines.push(`- overall score: ${heuristicEval.metrics.overallScore}`);
    lines.push(metricLine("specificity", {
      bandAccuracy: heuristicEval.metrics.bandAccuracy?.specificity,
      mae: heuristicEval.metrics.mae?.specificity,
      within015: heuristicEval.metrics.within015?.specificity
    }));
    lines.push(metricLine("profoundness", {
      bandAccuracy: heuristicEval.metrics.bandAccuracy?.profoundness,
      mae: heuristicEval.metrics.mae?.profoundness,
      within015: heuristicEval.metrics.within015?.profoundness
    }));
    lines.push(metricLine("coherence", {
      bandAccuracy: heuristicEval.metrics.bandAccuracy?.coherence,
      mae: heuristicEval.metrics.mae?.coherence,
      within015: heuristicEval.metrics.within015?.coherence
    }));
    lines.push(metricLine("anchor", heuristicEval.metrics.anchor));
  }
  lines.push("");
  if (fastEval.error) {
    lines.push(`- fast_only: unavailable (${fastEval.error})`);
  } else {
    lines.push(`- fast_only: ${fastEval.completedCases}/${fastEval.totalCases} completed, ${fastEval.failureCount} failures`);
    if (fastEval.availability) {
      lines.push(`- fast availability: ${fastEval.availability.status || "unknown"}`);
    }
    if (fastEval.metrics && fastEval.completedCases > 0) {
      lines.push(`- overall score: ${fastEval.metrics.overallScore}`);
      lines.push(metricLine("specificity", {
        bandAccuracy: fastEval.metrics.bandAccuracy?.specificity,
        mae: fastEval.metrics.mae?.specificity,
        within015: fastEval.metrics.within015?.specificity
      }));
      lines.push(metricLine("profoundness", {
        bandAccuracy: fastEval.metrics.bandAccuracy?.profoundness,
        mae: fastEval.metrics.mae?.profoundness,
        within015: fastEval.metrics.within015?.profoundness
      }));
      lines.push(metricLine("coherence", {
        bandAccuracy: fastEval.metrics.bandAccuracy?.coherence,
        mae: fastEval.metrics.mae?.coherence,
        within015: fastEval.metrics.within015?.coherence
      }));
      lines.push(metricLine("anchor", fastEval.metrics.anchor));
    } else if (fastEval.availability?.reason) {
      lines.push(`- fast eval reason: ${fastEval.availability.reason}`);
    }
  }
  lines.push("");
  lines.push("## PDF Fixture Results");
  if (!pdfResults.length) {
    lines.push("- No PDF fixtures found yet. Add sample PDFs under `tests/review-fixtures/pdfs/`.");
  } else {
    for (const pdf of pdfResults) {
      lines.push(`### ${pdf.file}`);
      lines.push(`- extraction method: ${pdf.extractionMethod}`);
      lines.push(`- weak extraction heuristic: ${pdf.weakNative ? "yes" : "no"}`);
      lines.push(`- extracted words: ${pdf.extractedWords}`);
      if (pdf.expectedWords != null) {
        lines.push(`- expected words: ${pdf.expectedWords}`);
      }
      lines.push("");
      lines.push("```text");
      lines.push(pdf.preview || "[empty preview]");
      lines.push("```");
      lines.push("");
    }
  }
  lines.push("## Human Smoke Checklist");
  lines.push("");
  lines.push(smokeChecklist.trim());
  lines.push("");

  const report = `${lines.join("\n")}\n`;
  const latestPath = path.join(outputDir, "latest.md");
  const datedPath = path.join(outputDir, `review-${Date.now()}.md`);
  await fs.writeFile(latestPath, report, "utf8");
  await fs.writeFile(datedPath, report, "utf8");

  console.log(`Wrote review report to ${latestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
