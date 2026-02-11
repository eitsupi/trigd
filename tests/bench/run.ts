#!/usr/bin/env -S deno run --allow-all
/**
 * Benchmark orchestrator for trigd plot rendering performance.
 *
 * Builds the Go server, starts it, connects a mock metrics client,
 * runs R benchmarks, and reports results.
 *
 * Usage:
 *   deno run --allow-all run.ts
 *   deno run --allow-all run.ts --skip-build   # skip Go build
 *   deno run --allow-all run.ts --no-client     # run without mock client (timeout mode)
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { TrigdServer } from "../server/helpers/server.ts";
import { MockMetricsClient } from "./mock-metrics-client.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const rootDir = join(scriptDir, "..", "..");
const serverDir = join(rootDir, "server");

const args = new Set(Deno.args);
const skipBuild = args.has("--skip-build");
const noClient = args.has("--no-client");

// --- Build ---
if (!skipBuild) {
  console.log("==> Building Go server...");
  const build = new Deno.Command("go", {
    args: ["build", "-o", "trigd", "."],
    cwd: serverDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const buildResult = await build.output();
  if (!buildResult.success) {
    console.error("Build failed");
    Deno.exit(1);
  }
}

// --- Start server ---
console.log("==> Starting trigd server...");
const server = new TrigdServer();
Deno.env.set("TRIGD_SERVER_BIN", join(serverDir, "trigd"));
await server.start();
console.log(`    Socket: ${server.socketPath}`);
console.log(`    HTTP:   ${server.httpBaseUrl}`);

// --- Connect mock client ---
let client: MockMetricsClient | null = null;
if (!noClient) {
  console.log("==> Connecting mock metrics client...");
  client = new MockMetricsClient(server.wsUrl);
  await client.connect();
  // Give the server a moment to register the client
  await new Promise((r) => setTimeout(r, 500));
  console.log("    Connected");
}

// --- Run R benchmarks ---
console.log("==> Running R benchmarks...");
const benchScript = join(scriptDir, "bench-plot.R");
const rCmd = new Deno.Command("Rscript", {
  args: [benchScript],
  stdout: "piped",
  stderr: "piped",
  env: {
    ...Deno.env.toObject(),
    TRIGD_SOCKET: server.socketPath,
  },
});

const rResult = await rCmd.output();
const stdout = new TextDecoder().decode(rResult.stdout);
const stderr = new TextDecoder().decode(rResult.stderr);

if (stderr.trim()) {
  console.log("\n--- R stderr ---");
  console.log(stderr.trim());
}

console.log("\n--- R output ---");
console.log(stdout.trim());

// --- Client stats ---
if (client) {
  const stats = client.stats();
  console.log("\n=== Mock Client Stats ===");
  console.log(`  Metrics requests: ${stats.metricsRequests} (strWidth: ${stats.strWidthRequests}, metricInfo: ${stats.metricInfoRequests})`);
  console.log(`  Frames received:  ${stats.framesReceived}`);
  console.log(`  Last frame ops:   ${stats.lastFrameOps}`);
  client.close();
}

// --- Cleanup ---
await server.shutdown();
server.cleanup();
console.log("\n==> Done.");
