#!/usr/bin/env -S deno run --allow-all
import { join, dirname, fromFileUrl } from "jsr:@std/path";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const serverDir = join(scriptDir, "..", "..", "servers", "go");

console.log("==> Building server...");
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

console.log("==> Running integration tests...");
const test = new Deno.Command("deno", {
  args: ["test", "--allow-all", join(scriptDir, "tests/")],
  env: { TRIGD_SERVER_BIN: join(serverDir, "trigd") },
  stdout: "inherit",
  stderr: "inherit",
});
const testResult = await test.output();
Deno.exit(testResult.success ? 0 : 1);
