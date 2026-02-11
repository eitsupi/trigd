import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { join } from "jsr:@std/path@1";
import { Hub } from "./hub.ts";
import { RSession } from "./r_session.ts";
import { writeDiscovery, removeDiscovery } from "./discovery.ts";
import { handleWebSocket } from "./websocket.ts";
import { serveStaticFile } from "./static.ts";
import { assets } from "./web_assets.ts";

async function main(): Promise<void> {
  // Go's flag package treats -socket and --socket identically.
  // Deno's parseArgs (minimist-style) only recognises --long-flags,
  // so normalise single-dash long options before parsing.
  const rawArgs = Deno.args.map((a) =>
    /^-(?:socket|http|tcp|web)$/.test(a) ? "-" + a : a,
  );

  const args = parseArgs(rawArgs, {
    string: ["socket", "http", "web"],
    boolean: ["v"],
    default: {
      socket: "",
      http: "127.0.0.1:0",
      web: "",
      v: false,
    },
  });

  const verbose = args.v;

  // Web directory for static files (optional, for development).
  // By default, embedded assets from web_assets.ts are served.
  // Use --web <dir> to serve from a local directory instead.
  const webDir = args.web;

  const hub = new Hub();
  hub.verbose = verbose;

  // Resolve socket path
  let socketPath = args.socket;
  if (!socketPath) {
    const token = new Uint8Array(8);
    crypto.getRandomValues(token);
    const hex = Array.from(token)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    socketPath = join(Deno.env.get("TMPDIR") || "/tmp", `trigd-${hex}.sock`);
  }

  // Clean up stale socket
  await cleanStaleSocket(socketPath);

  // Start R Unix socket listener
  const rListener = Deno.listen({ transport: "unix", path: socketPath });
  console.error(`R listener: ${socketPath}`);

  // Start HTTP server (port 0 = auto-assign)
  const [httpHost, httpPortStr] = splitHostPort(args.http);
  const httpServer = Deno.serve(
    { hostname: httpHost, port: parseInt(httpPortStr), onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        return handleWebSocket(req, hub);
      }
      if (webDir) {
        return serveStaticFile(req, webDir);
      }
      // Serve from embedded assets
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const asset = assets[pathname];
      if (!asset) {
        return new Response("not found", { status: 404 });
      }
      return new Response(asset.body, {
        headers: { "content-type": asset.type },
      });
    },
  );
  const httpPort = httpServer.addr.port;
  console.error(`HTTP server: http://127.0.0.1:${httpPort}/`);

  // Track active R connections for graceful shutdown
  const activeConnections = new Set<Promise<void>>();

  // Accept R connections (runs until listener is closed)
  acceptLoop(rListener, hub, activeConnections);

  // Write discovery file before announcing readiness so clients can
  // find the socket immediately after parsing the readiness message.
  const discoveryPaths = await writeDiscovery(socketPath, httpPort);

  // Print readiness message to stdout (parsed by test infrastructure)
  console.log("trigd server ready");
  console.log(`  R socket:  ${socketPath}`);
  console.log(`  HTTP:      http://127.0.0.1:${httpPort}/`);

  // Wait for shutdown signal
  const sig = await waitForSignal("SIGINT", "SIGTERM");

  console.error(`received signal ${sig}, shutting down...`);

  // 1. Close R listener (stop accepting new connections)
  rListener.close();

  // 2. Shutdown HTTP server
  await httpServer.shutdown();

  // 3. Close hub (close all connections)
  hub.close();

  // 4. Wait for active connections with timeout
  await Promise.race([
    Promise.allSettled(activeConnections),
    new Promise((r) => setTimeout(r, 5000)),
  ]);

  // 5. Cleanup discovery and socket files
  await removeDiscovery(discoveryPaths);
  try {
    await Deno.remove(socketPath);
  } catch { /* ignore */ }

  console.error("shutdown complete");
}

/**
 * Accept loop for Unix socket connections.
 * Spawns an RSession for each accepted connection.
 */
async function acceptLoop(
  listener: Deno.Listener,
  hub: Hub,
  activeConnections: Set<Promise<void>>,
): Promise<void> {
  for await (const conn of listener) {
    const session = new RSession(conn, hub);
    console.error(
      `R connection accepted: ${session.id} from unix socket`,
    );
    const done = session.run().finally(() => {
      activeConnections.delete(done);
    });
    activeConnections.add(done);
  }
}

/** Wait for any of the given signals. Cleans up all listeners on resolve. */
function waitForSignal(...signals: Deno.Signal[]): Promise<string> {
  return new Promise((resolve) => {
    const handlers: Array<[Deno.Signal, () => void]> = [];
    for (const sig of signals) {
      const handler = () => {
        // Remove all listeners so the unused ones don't keep the event loop alive
        for (const [s, h] of handlers) {
          Deno.removeSignalListener(s, h);
        }
        resolve(sig);
      };
      handlers.push([sig, handler]);
      Deno.addSignalListener(sig, handler);
    }
  });
}

/** Split "host:port" into [host, port]. */
function splitHostPort(addr: string): [string, string] {
  const lastColon = addr.lastIndexOf(":");
  if (lastColon < 0) return ["127.0.0.1", addr];
  return [addr.slice(0, lastColon), addr.slice(lastColon + 1)];
}

/**
 * Check for and remove a stale Unix socket file.
 * If the socket is in use by another process, exit with error.
 */
async function cleanStaleSocket(socketPath: string): Promise<void> {
  try {
    await Deno.stat(socketPath);
  } catch {
    return; // Socket doesn't exist — nothing to clean
  }

  // Try connecting to see if it's in use
  try {
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    conn.close();
    // Connection succeeded — socket is in use
    console.error(`socket ${socketPath} is in use by another process`);
    Deno.exit(1);
  } catch {
    // Connection failed — stale socket, remove it
    try {
      await Deno.remove(socketPath);
    } catch (e) {
      console.error(`failed to remove stale socket: ${e}`);
      Deno.exit(1);
    }
  }
}

main();
