import type { RSession } from "./r_session.ts";

/** Placeholder for browser clients (implemented in be2.2). */
export interface BrowserClient {
  send(data: string): void;
  close(): void;
}

/**
 * Hub routes messages between R sessions and browser clients.
 * JS is single-threaded so no mutex is needed — Map/Set suffice.
 */
export class Hub {
  sessions = new Map<string, RSession>();
  clients = new Set<BrowserClient>();
  /** Maps metrics request ID → R session ID for routing responses. */
  metricsRouting = new Map<number, string>();
  verbose = false;

  registerSession(session: RSession): void {
    this.sessions.set(session.id, session);
    console.error(
      `R session registered: ${session.id} (total: ${this.sessions.size})`,
    );
  }

  unregisterSession(id: string): void {
    this.sessions.delete(id);
    console.error(
      `R session unregistered: ${id} (total: ${this.sessions.size})`,
    );
  }

  /**
   * Update a session's ID (when the real sessionId is extracted from the
   * first frame message).
   */
  updateSessionId(oldId: string, newId: string, session: RSession): void {
    this.sessions.delete(oldId);
    this.sessions.set(newId, session);
  }

  /** Broadcast a message string to all connected browser clients. */
  broadcastToClients(data: string): void {
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
        // Slow/dead client — ignore
      }
    }
  }

  /** Broadcast a message string to all connected R sessions. */
  broadcastToR(data: string): void {
    for (const session of this.sessions.values()) {
      try {
        session.send(data);
      } catch (e) {
        console.error(
          `failed to send to R session ${session.id}: ${e}`,
        );
      }
    }
  }

  /**
   * Process a message from an R session.
   * Routes based on message type (frame, metrics_request, close, etc.).
   */
  handleRMessage(session: RSession, line: string): void {
    const type = extractType(line);

    switch (type) {
      case "frame": {
        // Inject sessionId into the plot object if not present
        let data = line;
        if (session.id && !line.includes('"sessionId"')) {
          data = injectSessionId(line, session.id);
        }
        this.broadcastToClients(data);
        if (this.verbose) {
          console.error(
            `frame from R session ${session.id} (${data.length} bytes)`,
          );
        }
        break;
      }

      case "metrics_request":
        this.handleMetricsRequest(session, line);
        break;

      case "close":
        if (this.verbose) {
          console.error(`device close from R session ${session.id}`);
        }
        this.broadcastToClients(line);
        break;

      default:
        // Unknown message type — forward to browsers
        this.broadcastToClients(line);
        break;
    }
  }

  /**
   * Route a metrics request from R to browsers, with timeout fallback.
   */
  private handleMetricsRequest(session: RSession, line: string): void {
    let id: number;
    try {
      const msg = JSON.parse(line);
      id = msg.id;
    } catch {
      console.error("failed to parse metrics request");
      return;
    }

    // No browsers connected → immediately send zero-value fallback
    if (this.clients.size === 0) {
      const fallback = JSON.stringify({
        type: "metrics_response",
        id,
        width: 0,
        ascent: 0,
        descent: 0,
      });
      try {
        session.send(fallback);
      } catch (e) {
        console.error(
          `failed to send metrics fallback to R session ${session.id}: ${e}`,
        );
      }
      return;
    }

    // Store routing: requestID → sessionID
    this.metricsRouting.set(id, session.id);

    // Forward to browsers
    this.broadcastToClients(line);

    // Timeout: if no response in 2s, send zero-value fallback
    setTimeout(() => {
      if (this.metricsRouting.has(id)) {
        this.metricsRouting.delete(id);
        const fallback = JSON.stringify({
          type: "metrics_response",
          id,
          width: 0,
          ascent: 0,
          descent: 0,
        });
        const target = this.sessions.get(session.id);
        if (target) {
          try {
            target.send(fallback);
          } catch (e) {
            console.error(
              `failed to send metrics fallback to R session ${session.id}: ${e}`,
            );
          }
        }
        if (this.verbose) {
          console.error(
            `metrics timeout for request ${id}, sent fallback to session ${session.id}`,
          );
        }
      }
    }, 2000);
  }

  /**
   * Route a metrics response from a browser to the originating R session.
   */
  handleMetricsResponse(line: string): void {
    let id: number;
    try {
      const msg = JSON.parse(line);
      id = msg.id;
    } catch {
      console.error("failed to parse metrics response");
      return;
    }

    const sessionId = this.metricsRouting.get(id);
    if (sessionId === undefined) {
      // Already timed out or duplicate
      return;
    }
    this.metricsRouting.delete(id);

    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.send(line);
      } catch (e) {
        console.error(
          `failed to send metrics response to R session ${sessionId}: ${e}`,
        );
      }
    }
  }

  /** Register a browser client. */
  registerClient(client: BrowserClient): void {
    this.clients.add(client);
    console.error(
      `browser client connected (total: ${this.clients.size})`,
    );
  }

  /** Unregister a browser client. */
  unregisterClient(client: BrowserClient): void {
    this.clients.delete(client);
    console.error(
      `browser client disconnected (total: ${this.clients.size})`,
    );
  }

  /** Shut down the hub and close all connections. */
  close(): void {
    for (const client of this.clients) {
      try {
        client.close();
      } catch { /* ignore */ }
    }
    this.clients.clear();

    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch { /* ignore */ }
    }
    this.sessions.clear();
  }
}

/**
 * Extract the "type" field from a JSON line without full parse.
 * Falls back to empty string on malformed input.
 */
function extractType(line: string): string {
  const m = line.match(/"type"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

/**
 * Inject sessionId into the plot object of a frame message.
 * Finds `"plot":{` or `"plot": {` and inserts `"sessionId":"<id>",` after
 * the opening brace — matching the Go server's injection logic.
 */
export function injectSessionId(line: string, sessionId: string): string {
  // Find "plot":{ or "plot": {
  const plotRe = /"plot"\s*:\s*\{/;
  const match = plotRe.exec(line);
  if (!match) return line;

  const insertPos = match.index + match[0].length;
  const escaped = JSON.stringify(sessionId);
  return (
    line.slice(0, insertPos) +
    `"sessionId":${escaped},` +
    line.slice(insertPos)
  );
}
