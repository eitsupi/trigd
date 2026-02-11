#!/usr/bin/env -S deno run --allow-all
/**
 * E2E test runner for trigd servers using Astral (headless Chrome).
 *
 * Usage:
 *   deno run --allow-all run.ts              # build & test Go server (default)
 *   deno run --allow-all run.ts --server=go  # same as above
 *   deno run --allow-all run.ts --server=deno # test Deno server (no build step)
 */
import { join, dirname, fromFileUrl } from "jsr:@std/path";
import { parseArgs } from "jsr:@std/cli/parse-args";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const rootDir = join(scriptDir, "..", "..");

const args = parseArgs(Deno.args, {
  string: ["server"],
  default: { server: "go" },
});

const server = args.server;

let serverBin: string;

if (server === "deno") {
  const mainTs = join(rootDir, "servers", "deno", "main.ts");
  const wrapper = join(Deno.makeTempDirSync(), "trigd-deno");
  Deno.writeTextFileSync(wrapper, `#!/bin/sh\nexec deno run --allow-all "${mainTs}" "$@"\n`);
  Deno.chmodSync(wrapper, 0o755);
  serverBin = wrapper;
  console.log(`==> Using Deno server: ${mainTs}`);
} else if (server === "go") {
  const serverDir = join(rootDir, "servers", "go");
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
  serverBin = join(serverDir, "trigd");
} else {
  console.error(`Unknown server: ${server}. Use --server=go or --server=deno`);
  Deno.exit(1);
}

console.log("==> Running E2E tests...");
const test = new Deno.Command("deno", {
  args: ["test", "--allow-all", join(scriptDir, "tests/")],
  env: { ...Deno.env.toObject(), TRIGD_SERVER_BIN: serverBin },
  stdout: "inherit",
  stderr: "inherit",
});
const testResult = await test.output();
Deno.exit(testResult.success ? 0 : 1);
