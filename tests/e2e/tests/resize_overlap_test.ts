import { assertEquals } from "@std/assert";
import { TrigdServer } from "../../server/helpers/server.ts";
import { RClient } from "../../server/helpers/r_client.ts";
import { BrowserClient } from "../../server/helpers/browser_client.ts";
import { E2EBrowser, readOfType } from "../helpers/browser.ts";
import { delay } from "@std/async";
import type { ResizeMessage } from "../../server/helpers/types.ts";

/**
 * Reproduction test for ghost/overlap bug:
 * Plot 2 images → navigate back to plot 1 → resize → two images overlap.
 */
Deno.test("E2E: resize after history navigation must not show ghost image", async (t) => {
  const server = new TrigdServer();
  const rClient = new RClient();
  const e2e = new E2EBrowser();
  const resizeSender = new BrowserClient();

  try {
    await server.start();
    await rClient.connect(server.socketPath);
    await e2e.launch();

    const page = await e2e.newPage(server.httpBaseUrl);
    await resizeSender.connect(server.wsUrl);

    // Consume the initial resize from browser connect
    await rClient.readMessage<ResizeMessage>();

    // Frame 1: entirely RED (#ff0000)
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#ff0000" } }],
      device: { width: 400, height: 300, bg: "#ff0000" },
    });
    await delay(500);

    // Frame 2: entirely BLUE (#0000ff)
    await rClient.sendFrame({
      ops: [{ op: "rect", x0: 0, y0: 0, x1: 400, y1: 300, gc: { fill: "#0000ff" } }],
      device: { width: 400, height: 300, bg: "#0000ff" },
    });
    await delay(500);

    await t.step("setup: at plot 2/2, canvas is blue", async () => {
      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "2 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasBlue, true, "plot 2 should show blue");
      assertEquals(colors.hasRed, false, "plot 2 should not show red");
    });

    await t.step("navigate to plot 1, canvas is red", async () => {
      await page.evaluate(`document.getElementById('btn-prev').click()`);
      await delay(300);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "plot 1 should show red");
      assertEquals(colors.hasBlue, false, "plot 1 should not show blue");
    });

    await t.step("mock resize while viewing plot 1 — no ghost/overlap", async () => {
      // Send resize from BrowserClient mock
      resizeSender.sendResize(800, 600);

      const msg = await readOfType<ResizeMessage>(
        rClient, "resize", (m) => m.width === 800,
      );
      assertEquals(msg.width, 800);

      // R responds with the latest plot redrawn at new size.
      // Server should tag this with resize:true → replaceLatest, not addPlot.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 800, y1: 600, gc: { fill: "#00ff00" } }],
        device: { width: 800, height: 600, bg: "#00ff00" },
      });
      await delay(500);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "toolbar should stay at plot 1");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should show plot 1 (red)");
      assertEquals(colors.hasBlue, false, "canvas must not show ghost of plot 2 (blue)");
      assertEquals(colors.hasGreen, false, "canvas must not show resize frame (green)");
    });

    await t.step("real ResizeObserver resize — no ghost/overlap", async () => {
      // Navigate back to plot 1 (might already be there)
      const infoPre = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      if (infoPre !== "1 / 2") {
        await page.evaluate(`document.getElementById('btn-prev').click()`);
        await delay(300);
      }

      // Change container size via JS to trigger the actual ResizeObserver
      await page.evaluate(`(function() {
        var c = document.getElementById('canvas-container');
        c.style.width = '600px';
        c.style.height = '400px';
      })()`);

      // The ResizeObserver fires → replayCurrentPlot() + debounced resize (300ms)
      // Wait for the debounced resize message to reach R
      const msg = await readOfType<ResizeMessage>(rClient, "resize", 3000);

      // R responds with resize frame
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: msg.width, y1: msg.height, gc: { fill: "#00ff00" } }],
        device: { width: msg.width, height: msg.height, bg: "#00ff00" },
      });
      await delay(500);

      const info = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      assertEquals(info, "1 / 2", "toolbar should stay at plot 1 after real resize");

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should still show plot 1 (red)");
      assertEquals(colors.hasBlue, false, "no ghost of plot 2 (blue)");
      assertEquals(colors.hasGreen, false, "no leak of resize frame (green)");
    });

    await t.step("double resize race — second frame must not addPlot", async () => {
      // This tests the race: two resize messages before R responds.
      // The boolean resizePending flag can only tag ONE frame.
      // Navigate to plot 1 if not already there
      const infoPre = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;
      if (infoPre !== "1 / 2") {
        await page.evaluate(`document.getElementById('btn-prev').click()`);
        await delay(300);
      }

      const countBefore = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;

      // Send TWO resizes rapidly (before R can respond)
      resizeSender.sendResize(900, 700);
      resizeSender.sendResize(1000, 750);

      // Read both resize messages at R
      const r1 = await readOfType<ResizeMessage>(rClient, "resize", (m) => m.width === 900);
      const r2 = await readOfType<ResizeMessage>(rClient, "resize", (m) => m.width === 1000);
      assertEquals(r1.width, 900);
      assertEquals(r2.width, 1000);

      // R sends TWO frames (one per resize). The server's boolean flag
      // will only tag the first. The second might be treated as addPlot.
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 900, y1: 700, gc: { fill: "#00ff00" } }],
        device: { width: 900, height: 700, bg: "#00ff00" },
      });
      await rClient.sendFrame({
        ops: [{ op: "rect", x0: 0, y0: 0, x1: 1000, y1: 750, gc: { fill: "#ffff00" } }],
        device: { width: 1000, height: 750, bg: "#ffff00" },
      });
      await delay(500);

      // Check: did the second frame cause addPlot (extra history entry)?
      const countAfter = await page.evaluate(
        `document.getElementById('plot-info').textContent`,
      ) as string;

      // Both resize responses should use replaceLatest, not addPlot.
      // If we went from "1 / 2" to "1 / 3" or "3 / 3", that's the bug.
      assertEquals(
        countAfter, countBefore,
        `double resize should not add history entries: was ${countBefore}, now ${countAfter}`,
      );

      const colors = await sampleCanvasColors(page);
      assertEquals(colors.hasRed, true, "canvas should still show plot 1 (red)");
      assertEquals(colors.hasGreen, false, "no leak of first resize frame (green)");
      assertEquals(colors.hasYellow, false, "no leak of second resize frame (yellow)");
    });

  } finally {
    resizeSender.close();
    await e2e.close();
    rClient.close();
    await delay(100);
    await server.shutdown();
    server.cleanup();
  }
});

/** Sample pixel colors from the canvas and detect presence of R/G/B/Y fills. */
async function sampleCanvasColors(
  page: import("@astral/astral").Page,
): Promise<{ hasRed: boolean; hasGreen: boolean; hasBlue: boolean; hasYellow: boolean }> {
  return await page.evaluate(`(function() {
    var c = document.getElementById('plot-canvas');
    if (!c || c.width === 0 || c.height === 0) {
      return { hasRed: false, hasGreen: false, hasBlue: false, hasYellow: false };
    }
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var hasRed = false, hasGreen = false, hasBlue = false, hasYellow = false;
    // Sample every 100th pixel for speed
    for (var i = 0; i < data.length; i += 400) {
      var r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 128) continue;
      if (r > 200 && g < 50 && b < 50) hasRed = true;
      if (g > 200 && r < 50 && b < 50) hasGreen = true;
      if (b > 200 && r < 50 && g < 50) hasBlue = true;
      if (r > 200 && g > 200 && b < 50) hasYellow = true;
    }
    return { hasRed: hasRed, hasGreen: hasGreen, hasBlue: hasBlue, hasYellow: hasYellow };
  })()`) as { hasRed: boolean; hasGreen: boolean; hasBlue: boolean; hasYellow: boolean };
}
