#!/usr/bin/env -S deno run --allow-all
/**
 * Benchmark orchestrator for trigd plot rendering performance.
 *
 * Builds the server, starts it, connects a mock metrics client,
 * runs R benchmarks, and reports results.
 *
 * Usage:
 *   deno run --allow-all run.ts                  # build & bench Go server (default)
 *   deno run --allow-all run.ts --server=go      # same as above
 *   deno run --allow-all run.ts --server=deno    # bench Deno server (no build step)
 *   deno run --allow-all run.ts --server=both    # bench both and compare
 *   deno run --allow-all run.ts --skip-build     # skip Go server build
 *   deno run --allow-all run.ts --no-client      # run without mock client (timeout mode)
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { TrigdServer } from "../server/helpers/server.ts";
import { MockMetricsClient, type MockMetricsStats } from "./mock-metrics-client.ts";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const rootDir = join(scriptDir, "..", "..");

const args = parseArgs(Deno.args, {
  string: ["server"],
  boolean: ["skip-build", "no-client"],
  default: { server: "go", "skip-build": false, "no-client": false },
});

const serverChoice = args.server;
const skipBuild = args["skip-build"];
const noClient = args["no-client"];

interface BenchResult {
  label: string;
  elapsed: number;
}

interface RunResult {
  server: string;
  benchmarks: BenchResult[];
  stats: MockMetricsStats | null;
}

/** Resolve the server binary path, building Go if needed. */
async function resolveServerBin(server: string): Promise<string> {
  if (server === "deno") {
    const mainTs = join(rootDir, "servers", "deno", "main.ts");
    const wrapper = join(Deno.makeTempDirSync(), "trigd-deno");
    Deno.writeTextFileSync(
      wrapper,
      `#!/bin/sh\nexec deno run --allow-all "${mainTs}" "$@"\n`,
    );
    Deno.chmodSync(wrapper, 0o755);
    return wrapper;
  }

  const serverDir = join(rootDir, "servers", "go");
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
  return join(serverDir, "trigd");
}

/** Run benchmarks against a single server and return results. */
async function benchServer(serverType: string): Promise<RunResult> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Benchmarking: ${serverType} server`);
  console.log(`${"=".repeat(60)}`);

  // Resolve binary
  const serverBin = await resolveServerBin(serverType);

  // Start server
  console.log("==> Starting server...");
  const server = new TrigdServer();
  Deno.env.set("TRIGD_SERVER_BIN", serverBin);
  await server.start();
  console.log(`    Socket: ${server.socketPath}`);
  console.log(`    HTTP:   ${server.httpBaseUrl}`);

  // Connect mock client
  let client: MockMetricsClient | null = null;
  if (!noClient) {
    console.log("==> Connecting mock metrics client...");
    client = new MockMetricsClient(server.wsUrl);
    await client.connect();
    await new Promise((r) => setTimeout(r, 500));
    console.log("    Connected");
  }

  // Run R benchmarks
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

  // Parse JSON results
  let benchmarks: BenchResult[] = [];
  const jsonMatch = stdout.match(/=== JSON ===\s*\n\s*(\[.*\])/);
  if (jsonMatch) {
    benchmarks = JSON.parse(jsonMatch[1]);
  }

  // Client stats
  let stats: MockMetricsStats | null = null;
  if (client) {
    stats = client.stats();
    console.log("\n=== Mock Client Stats ===");
    console.log(
      `  Metrics requests: ${stats.metricsRequests} (strWidth: ${stats.strWidthRequests}, metricInfo: ${stats.metricInfoRequests})`,
    );
    console.log(`  Frames received:  ${stats.framesReceived}`);
    console.log(`  Total ops:        ${stats.totalOps}`);
    client.close();
  }

  // Cleanup
  await server.shutdown();
  server.cleanup();

  return { server: serverType, benchmarks, stats };
}

/** Print a comparison table of two results. */
function printComparison(go: RunResult, deno: RunResult): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Comparison: Go vs Deno");
  console.log(`${"=".repeat(60)}\n`);

  // Build lookup map for trigd benchmarks
  const goMap = new Map<string, number>();
  const denoMap = new Map<string, number>();

  for (const b of go.benchmarks) {
    if (b.label.startsWith("trigd:")) {
      goMap.set(b.label.replace("trigd:", ""), b.elapsed);
    }
  }
  for (const b of deno.benchmarks) {
    if (b.label.startsWith("trigd:")) {
      denoMap.set(b.label.replace("trigd:", ""), b.elapsed);
    }
  }

  // Header
  console.log(
    `  ${"Plot".padEnd(22)} ${"Go".padStart(9)} ${"Deno".padStart(9)} ${"Ratio".padStart(9)}`,
  );
  console.log(`  ${"-".repeat(22)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(9)}`);

  for (const [label, goTime] of goMap) {
    const denoTime = denoMap.get(label);
    if (denoTime !== undefined) {
      const ratio = denoTime / goTime;
      console.log(
        `  ${label.padEnd(22)} ${(goTime.toFixed(3) + "s").padStart(9)} ${(denoTime.toFixed(3) + "s").padStart(9)} ${ratio.toFixed(2).padStart(8)}x`,
      );
    }
  }

  // Client stats comparison
  if (go.stats && deno.stats) {
    console.log(`\n  ${"Metric".padEnd(22)} ${"Go".padStart(9)} ${"Deno".padStart(9)}`);
    console.log(`  ${"-".repeat(22)} ${"-".repeat(9)} ${"-".repeat(9)}`);
    console.log(
      `  ${"Metrics requests".padEnd(22)} ${String(go.stats.metricsRequests).padStart(9)} ${String(deno.stats.metricsRequests).padStart(9)}`,
    );
    console.log(
      `  ${"Frames received".padEnd(22)} ${String(go.stats.framesReceived).padStart(9)} ${String(deno.stats.framesReceived).padStart(9)}`,
    );
    console.log(
      `  ${"Total ops".padEnd(22)} ${String(go.stats.totalOps).padStart(9)} ${String(deno.stats.totalOps).padStart(9)}`,
    );
  }
}

// --- Main ---
const servers = serverChoice === "both" ? ["go", "deno"] : [serverChoice];
const results: RunResult[] = [];

for (const s of servers) {
  if (s !== "go" && s !== "deno") {
    console.error(`Unknown server: ${s}. Use --server=go, --server=deno, or --server=both`);
    Deno.exit(1);
  }
  results.push(await benchServer(s));
}

if (results.length === 2) {
  printComparison(results[0], results[1]);
}

console.log("\n==> Done.");
