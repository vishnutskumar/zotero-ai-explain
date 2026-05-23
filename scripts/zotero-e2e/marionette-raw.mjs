#!/usr/bin/env node
/**
 * Bare-socket marionette probe: connects to the given port, dumps every
 * byte received for ~5 seconds, then exits.
 *
 * Usage: node scripts/zotero-e2e/marionette-raw.mjs [host] [port]
 */

import { connect } from "node:net";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "2828");

process.stderr.write(`[raw] connecting to ${host}:${port}\n`);

const socket = connect({ host, port }, () => {
  process.stderr.write("[raw] connected\n");
});

let total = 0;
socket.on("data", (chunk) => {
  total += chunk.length;
  process.stderr.write(`[raw] received ${chunk.length} bytes (total ${total}):\n`);
  process.stderr.write(`  hex: ${chunk.toString("hex").slice(0, 200)}\n`);
  process.stderr.write(`  utf8: ${JSON.stringify(chunk.toString("utf8"))}\n`);
});
socket.on("error", (err) => {
  process.stderr.write(`[raw] error: ${err.message}\n`);
});
socket.on("close", () => {
  process.stderr.write(`[raw] socket closed (total ${total} bytes)\n`);
  process.exit(0);
});

setTimeout(() => {
  process.stderr.write("[raw] timeout reached; closing\n");
  socket.destroy();
}, 5_000);
