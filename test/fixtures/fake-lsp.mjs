#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("odoo_ls_server 1.5.2"); process.exit(0); }
const neverInitialize = process.env.FAKE_LSP_NEVER_INITIALIZE === "1";
const crashMarker = process.env.FAKE_LSP_CRASH_MARKER;
const recordFile = process.env.FAKE_LSP_RECORD_FILE;
const profileIndex = process.argv.indexOf("--selected-config");
const selectedProfile = profileIndex >= 0 && process.argv[profileIndex + 1] && !process.argv[profileIndex + 1].startsWith("--") ? process.argv[profileIndex + 1] : null;
let buffer = Buffer.alloc(0); let reverse = new Set();
let referencesTail = Promise.resolve();
let shutdownPublication;
let received = { argv: process.argv.slice(2), selectedProfile, configuredProfile: null, didOpen: [], didChange: [], didClose: [], didChangeWatchedFiles: [] };
if (recordFile) appendFileSync(recordFile, `${JSON.stringify({ event: "spawn", pid: process.pid, argv: process.argv.slice(2) })}\n`);
const record = () => { if (recordFile) appendFileSync(recordFile, `${JSON.stringify({ event: "snapshot", pid: process.pid, received })}\n`); };
const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); };
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString()); if (!match) process.exit(2);
    const length = Number(match[1]); if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()); buffer = buffer.subarray(end + 4 + length);
    if (["textDocument/didOpen", "textDocument/didChange"].includes(message.method) && message.params.textDocument.uri.includes("diagnostic-fixture.")) {
      const document = message.params.textDocument;
      const text = document.text ?? message.params.contentChanges[0].text;
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: text.includes("DIAGNOSTIC_FIXTURE_ISSUE") ? [{ message: "fixture issue", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [] } });
    }
    if (message.method === "textDocument/didOpen") received.didOpen.push(message.params || {});
    if (message.method === "textDocument/didChange") received.didChange.push(message.params || {});
    if (message.method === "textDocument/didClose") received.didClose.push(message.params || {});
    if (message.method === "workspace/didChangeWatchedFiles") received.didChangeWatchedFiles.push(message.params || {});
    record();
    if (message.method === "initialize") {
      if (neverInitialize) continue;
      reverse = new Set([900, 901, 902]);
      send({ jsonrpc: "2.0", id: 900, method: "workspace/configuration", params: { items: [{}] } });
      send({ jsonrpc: "2.0", id: 901, method: "client/registerCapability", params: { registrations: [] } });
      send({ jsonrpc: "2.0", id: 902, method: "unknown/reverseRequest", params: {} });
      const complete = () => { if (reverse.size) return; send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } }); setTimeout(() => { send({ jsonrpc: "2.0", method: "$Odoo/setConfiguration", params: [] }); send({ jsonrpc: "2.0", method: "$Odoo/loadingStatusUpdate", params: "stop" }); }, 10); };
      globalThis.completeInitialize = complete;
    } else if (message.method === "$/cancelRequest") send({ jsonrpc: "2.0", method: "$/cancelRequest", params: message.params });
    else if (message.id !== undefined && reverse.has(message.id)) {
      if (message.id === 900) received.configuredProfile = message.result?.[0]?.selectedProfile ?? null;
      reverse.delete(message.id); record(); globalThis.completeInitialize?.();
    } else if (message.method === "test/getReceived") send({ jsonrpc: "2.0", id: message.id, result: received });
    else if (message.method === "test/readinessNotifications") {
      const notifications = Array.isArray(message.params) ? message.params : [];
      for (const notification of notifications) send({ jsonrpc: "2.0", method: notification.method, params: notification.params });
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
    else if (message.method === "textDocument/references" && process.env.FAKE_LSP_REFERENCES_DELAY_MS) {
      referencesTail = referencesTail.then(() => new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_LSP_REFERENCES_DELAY_MS)))).then(() => send({ jsonrpc: "2.0", id: message.id, result: [] }));
    }
    else if (message.method === "textDocument/hover") {
      if (message.params.position.line === 1) continue;
      const result = message.params.position.character === 0 ? null : { contents: { kind: "markdown", value: "**hover**" }, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } };
      send({ jsonrpc: "2.0", id: message.id, result });
    }
    else if (message.method === "test/shutdownPublication") { shutdownPublication = message.params; send({ jsonrpc: "2.0", id: message.id, result: null }); }
    else if (message.method === "shutdown") {
      if (shutdownPublication) send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: shutdownPublication });
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
    else if (message.method === "slow") setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: null }), 500);
    else if (message.method === "test/crash") { if (crashMarker) { try { appendFileSync(crashMarker, "x"); } catch {} } process.exit(7); }
    else if (message.id !== undefined && message.method) send({ jsonrpc: "2.0", id: message.id, result: null });
  }
});
