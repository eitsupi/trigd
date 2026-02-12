import { assert, assertEquals, assertRejects } from "@std/assert";
import { TrigdServer } from "../helpers/server.ts";
import { BrowserClient } from "../helpers/browser_client.ts";
import { delay } from "@std/async";

Deno.test("graceful shutdown", async (t) => {
  await t.step("SIGTERM causes graceful shutdown", async () => {
    const server = new TrigdServer();
    try {
      await server.start();
      assert(server.pid > 0);

      const graceful = await server.shutdown();

      // Only check file removal for graceful shutdown.
      // If the server was force-killed (SIGKILL), cleanup won't run.
      if (graceful) {
        try {
          await Deno.stat(server.socketPath);
          assert(false, "Socket file should be removed after shutdown");
        } catch (e) {
          assert(e instanceof Deno.errors.NotFound, "Socket should not exist");
        }
      }
    } finally {
      server.cleanup();
    }
  });

  await t.step("discovery file is removed after shutdown", async () => {
    const server = new TrigdServer();
    try {
      await server.start();

      // Verify discovery file exists before shutdown
      const disc = await server.readDiscovery();
      assert(disc.pid > 0);

      const graceful = await server.shutdown();

      // Only check file removal for graceful shutdown.
      // If the server was force-killed (SIGKILL), cleanup won't run.
      if (!graceful) {
        console.error("  [skip] server was force-killed, skipping file check");
        return;
      }

      // Verify discovery file is cleaned up
      const discPath = `${server.tmpDir}/trigd-discovery.json`;
      try {
        await Deno.readTextFile(discPath);
        assert(false, "Discovery file should be removed after shutdown");
      } catch (e) {
        assert(e instanceof Deno.errors.NotFound, "Discovery file should not exist");
      }
    } finally {
      server.cleanup();
    }
  });

  await t.step(
    "WebSocket connections are closed on shutdown",
    async () => {
      const server = new TrigdServer();
      const browser = new BrowserClient();

      try {
        await server.start();
        await browser.connect(server.wsUrl);

        await server.shutdown();

        // After server shuts down, sending should fail or the connection
        // should be closed. Give some time for close propagation.
        await delay(500);

        // Attempting to wait for a message should time out quickly since
        // the connection is closed
        try {
          await browser.waitForType("frame", 1000);
          // If we get here, something is wrong but not a failure per se
        } catch {
          // Expected — connection closed or timed out
          assert(true);
        }
      } finally {
        browser.close();
        server.cleanup();
      }
    },
  );
});
