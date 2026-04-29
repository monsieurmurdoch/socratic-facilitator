#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const statusPath = path.join(repoRoot, "status.md");
const roadmapPath = path.join(repoRoot, "docs", "roadmap-bizplan.md");
const defaultObsidianDir = path.join(
  os.homedir(),
  "Documents",
  "Obsidian Vault",
  "Coding",
  "Socratic-Facilitator (Expanse)"
);
const obsidianDir = process.env.OBSIDIAN_STATUS_DIR || defaultObsidianDir;

const args = process.argv.slice(2);
const shouldPushUpdate = args.includes("--push-update");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (_error) {
    return "";
  }
}

function read(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function write(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

function between(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(start + startMarker.length, end).trim();
}

function replaceBetween(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Missing markers: ${startMarker} / ${endMarker}`);
  }
  return [
    content.slice(0, start + startMarker.length),
    "\n",
    replacement.trim(),
    "\n",
    content.slice(end)
  ].join("");
}

function buildPushSnapshot() {
  const now = new Date().toISOString();
  const branch = git(["branch", "--show-current"]) || "unknown";
  const commit = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const flagIndex = args.indexOf("--push-update");
  const remoteNameArg = flagIndex >= 0 ? args[flagIndex + 1] : "";
  const status = git(["status", "--short"]);
  const changed = status
    ? status.split("\n").slice(0, 12).map(line => `  - ${line}`).join("\n")
    : "  - Clean working tree";

  return `## Current Push Snapshot

- Last updated: ${now}
- Branch: ${branch}
- Commit: ${commit}
- Push remote: ${remoteNameArg || "not provided"}
- Working tree:
${changed}`;
}

function updateStatusForPush() {
  let content = read(statusPath);
  if (!content) {
    throw new Error(`Missing ${statusPath}`);
  }

  const currentStart = "<!-- PUSH-UPDATE:CURRENT:START -->";
  const currentEnd = "<!-- PUSH-UPDATE:CURRENT:END -->";
  const archiveStart = "<!-- PUSH-UPDATE:ARCHIVE:START -->";
  const archiveEnd = "<!-- PUSH-UPDATE:ARCHIVE:END -->";

  const previousCurrent = between(content, currentStart, currentEnd);
  const previousArchive = between(content, archiveStart, archiveEnd) || "";
  const nextCurrent = buildPushSnapshot();

  content = replaceBetween(content, currentStart, currentEnd, nextCurrent);

  const currentCommit = (nextCurrent.match(/^- Commit: (.+)$/m) || [])[1];
  const previousCommit = (previousCurrent?.match(/^- Commit: (.+)$/m) || [])[1];
  const shouldArchivePrevious =
    previousCurrent &&
    !previousCurrent.includes("pending first sync") &&
    previousCommit &&
    previousCommit !== currentCommit;

  if (shouldArchivePrevious) {
    const archiveBody = previousArchive === "No archived push updates yet."
      ? previousCurrent
      : `${previousCurrent}\n\n---\n\n${previousArchive}`;
    content = replaceBetween(content, archiveStart, archiveEnd, archiveBody);
  }

  write(statusPath, content);
}

function mirrorToObsidian() {
  fs.mkdirSync(obsidianDir, { recursive: true });
  fs.copyFileSync(statusPath, path.join(obsidianDir, "status.md"));
  fs.copyFileSync(roadmapPath, path.join(obsidianDir, "roadmap-bizplan.md"));
  console.log(`[status-sync] Mirrored status docs to ${obsidianDir}`);
}

if (shouldPushUpdate) {
  updateStatusForPush();
}

mirrorToObsidian();
