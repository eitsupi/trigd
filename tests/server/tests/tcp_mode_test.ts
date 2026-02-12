import { assert, assertEquals } from "@std/assert";
import { TrigdServer } from "../helpers/server.ts";
import { RClient } from "../helpers/r_client.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { delay } from "@std/async";
import type { FrameMessage, ResizeMessage } from "../helpers/types.ts";

Deno.test("TCP mode (Windows fallback)", async (t) => {
  const server = new TrigdServer({ tcp: true });
  const rClient = new RClient();
  const browser = new BrowserClient();

  try {
    await server.start();

    // Go server ignores --tcp 0 on non-Windows (tcpPort > 0 guard).
    // Skip this test when the server didn't actually use TCP mode.
    if (!server.socketPath.startsWith("tcp:")) {
      console.error(
        "  [skip] server did not enable TCP mode " +
        `(got ${server.socketPath}); --tcp 0 is only honored by the Deno server`,
      );
      return;
    }

    await t.step("server reports tcp:PORT socket path", () => {
      const port = parseInt(server.socketPath.slice(4), 10);
      assert(port > 0, `Expected valid port, got ${port}`);
    });

    await t.step("discovery file contains tcp:PORT", async () => {
      const disc = await server.readDiscovery();
      assertEquals(disc.socketPath, server.socketPath);
      assert(disc.socketPath.startsWith("tcp:"));
    });

    await t.step("R client connects via TCP", async () => {
      await rClient.connect(server.socketPath);
    });

    await t.step("frame relay works over TCP", async () => {
      await browser.connect(server.wsUrl);

      // Wait for browser registration
      browser.sendResize(200, 200);
      await rClient.readMessage<ResizeMessage>();

      await rClient.sendFrame({
        sessionId: "tcp-test",
        ops: [{ op: "rect", x: 0, y: 0, w: 100, h: 100 }],
        device: { width: 200, height: 200 },
      });

      const msg = await browser.waitForType<FrameMessage>("frame");
      assertEquals(msg.type, "frame");
      assertEquals(msg.plot.sessionId, "tcp-test");
      assertEquals(msg.plot.ops.length, 1);
    });
  } finally {
    browser.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});
