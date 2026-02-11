import { launch } from "@astral/astral";
import type { Browser, Page } from "@astral/astral";

/**
 * Wraps Astral browser lifecycle for E2E tests.
 * Launches headless Chrome once, creates pages per test.
 */
export class E2EBrowser {
  #browser: Browser | null = null;

  async launch(): Promise<void> {
    this.#browser = await launch({ headless: true });
  }

  async newPage(url: string): Promise<Page> {
    if (!this.#browser) throw new Error("Browser not launched");
    const page = await this.#browser.newPage(url);
    return page;
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
    }
  }
}

/** Check if canvas at selector has any non-transparent pixels. */
export async function canvasHasContent(page: Page, selector = "#plot-canvas"): Promise<boolean> {
  return await page.evaluate(`(function() {
    var c = document.querySelector('${selector}');
    if (!c || c.width === 0 || c.height === 0) return false;
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (var i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  })()`) as boolean;
}

/** Get the canvas pixel dimensions (accounting for DPR). */
export async function canvasDimensions(page: Page, selector = "#plot-canvas"): Promise<{ width: number; height: number }> {
  return await page.evaluate(`(function() {
    var c = document.querySelector('${selector}');
    return { width: c ? c.width : 0, height: c ? c.height : 0 };
  })()`) as { width: number; height: number };
}

/** Get toolbar text content. */
export async function plotInfoText(page: Page): Promise<string> {
  return await page.evaluate(`(function() {
    var el = document.getElementById('plot-info');
    return el ? el.textContent : '';
  })()`) as string;
}
