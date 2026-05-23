#!/usr/bin/env node
/**
 * Print every entry in an .xpi (Zip) file. Used by the agent to verify
 * `package-xpi.mjs` bundled the llm-proxy/ tree without shelling out to
 * unzip. Reads the central directory directly.
 */
import { readFileSync } from "node:fs";
import { argv } from "node:process";

const path = argv[2] ?? "zotero-ai-explain.xpi";
const buf = readFileSync(path);
const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const entries = [];
let i = 0;
while (i < buf.length - 4) {
  const idx = buf.indexOf(sig, i);
  if (idx === -1) break;
  const nameLen = buf.readUInt16LE(idx + 28);
  const extraLen = buf.readUInt16LE(idx + 30);
  const commentLen = buf.readUInt16LE(idx + 32);
  const name = buf.slice(idx + 46, idx + 46 + nameLen).toString("utf8");
  const size = buf.readUInt32LE(idx + 24);
  entries.push({ name, size });
  i = idx + 46 + nameLen + extraLen + commentLen;
}
entries.sort((a, b) => a.name.localeCompare(b.name));
for (const e of entries) {
  console.log(`${String(e.size).padStart(8)} ${e.name}`);
}
