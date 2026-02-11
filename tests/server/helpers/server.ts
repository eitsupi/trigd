import { dirname, fromFileUrl, join } from "@std/path";
import type { DiscoveryFile } from "./types.ts";

/**
 * Manages a trigd server process for testing.
 * Each instance gets its own socket, HTTP port, and TMPDIR.
 */
export class TrigdServer {
  readonly socketPath: string;
  readonly tmpDir: string;

  httpPort = 0;
  pid = 0;

  #process: Deno.ChildProcess | null = null;
  #stdout: ReadableStream<string> | null = null;

  constructor() {
    this.tmpDir = Deno.makeTempDirSync({ prefix: "trigd-test-" });
    this.socketPath = join(
      this.tmpDir,
      `trigd-${crypto.randomUUID().slice(0, 8)}.sock`,
    );
  }

  /** Start the server and wait for it to be ready. */
  async start(): Promise<void> {
    const bin =
      Deno.env.get("TRIGD_SERVER_BIN") ??
      join(
        dirname(fromFileUrl(import.meta.url)),
        "..", "..", "..", "servers", "go", "trigd",
      );

    const cmd = new Deno.Command(bin, {
      args: ["-socket", this.socketPath, "-http", "127.0.0.1:0", "-v"],
      stdout: "piped",
      stderr: "piped",
      env: { TMPDIR: this.tmpDir },
    });

    this.#process = cmd.spawn();

    // Drain stderr in the background (avoid blocking)
    this.#process.stderr
      .pipeTo(
        new WritableStream({
          write(chunk) {
            if (Deno.env.get("TRIGD_TEST_VERBOSE")) {
              Deno.stderr.writeSync(chunk);
            }
          },
        }),
      )
      .catch(() => {});

    // Read stdout line by line looking for the ready sentinel
    this.#stdout = this.#process.stdout.pipeThrough(new TextDecoderStream());

    const reader = this.#stdout.getReader();
    let buffer = "";

    const timeout = AbortSignal.timeout(10_000);
    try {
      while (!timeout.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("Server exited before becoming ready");
        }
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("trigd server ready")) {
            // Parse HTTP port from subsequent line
            continue;
          }
          const httpMatch = line.match(
            /HTTP:\s+http:\/\/127\.0\.0\.1:(\d+)/,
          );
          if (httpMatch) {
            this.httpPort = parseInt(httpMatch[1], 10);
          }
        }

        if (this.httpPort > 0) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (this.httpPort === 0) {
      throw new Error("Failed to detect HTTP port from server output");
    }

    this.pid = this.#process.pid;
  }

  get httpBaseUrl(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.httpPort}/ws`;
  }

  /** Read the discovery file written by the server. */
  async readDiscovery(): Promise<DiscoveryFile> {
    const path = join(this.tmpDir, "trigd-discovery.json");
    const text = await Deno.readTextFile(path);
    return JSON.parse(text);
  }

  /** Send SIGTERM and wait for exit. Falls back to SIGKILL after 5s. */
  async shutdown(): Promise<void> {
    if (!this.#process) return;

    try {
      this.#process.kill("SIGTERM");
    } catch {
      // Process may have already exited
      return;
    }

    const timeoutId = setTimeout(() => {
      try {
        this.#process!.kill("SIGKILL");
      } catch {
        // Already exited
      }
    }, 5000);

    try {
      await this.#process.status;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Clean up temp files. */
  cleanup(): void {
    try {
      Deno.removeSync(this.tmpDir, { recursive: true });
    } catch {
      // Best effort
    }
  }
}
