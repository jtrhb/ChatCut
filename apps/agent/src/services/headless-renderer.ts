import type { SerializedEditorState } from "@opencut/core";
import type { ObjectStorage } from "./object-storage.js";

/**
 * HeadlessRenderer (audit Phase 3 / spec plan §7.9).
 *
 * Browser-pool orchestration shell. Real Playwright integration is the
 * production binding; this module abstracts the browser+page seam so
 * orchestration is testable without chromium installed and without a
 * functioning renderer module on the web side.
 *
 * **Phase 3 status: SCAFFOLD** — wired into the preview-render job
 * worker (gated on RENDERER_BASE_URL + R2). Two pieces remain before
 * preview rendering actually produces playable MP4s:
 *   1. A renderer-friendly static build of `apps/web` that Playwright
 *      can load and that exposes the rendered bytes via `page.evaluate`
 *      (plan §3.3 — the highest-risk single task). Doesn't exist yet.
 *   2. Playwright + chromium installed on the agent host (plan §3.1).
 * Until both land, exportVideo() runs the orchestration but the
 * `page.evaluate` body must be supplied by whoever ships the renderer.
 *
 * The browser-pool semantics + URL templating + R2 upload contract are
 * tested behaviorally with mock browsers — the contract crystallizes
 * here so the eventual Playwright binding is a drop-in replacement.
 */

export interface RenderPage {
  goto(url: string, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface RenderBrowser {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

export type BrowserFactory = () => Promise<RenderBrowser>;

export interface HeadlessRendererDeps {
  browserFactory: BrowserFactory;
  objectStorage: ObjectStorage;
  /**
   * Base URL of the renderer-friendly static build (e.g.
   * "https://renderer.chatcut.app" or "file:///app/dist/renderer/index.html").
   * The renderer is responsible for accepting query params and exposing
   * the rendered bytes via the agreed page.evaluate contract.
   */
  rendererBaseUrl: string;
  /** Default 4 — matches spec's expected per-instance baseline. */
  poolSize?: number;
  /** Default 60s. */
  pageTimeoutMs?: number;
}

export interface ExportVideoParams {
  explorationId: string;
  candidateId: string;
  timelineSnapshot: SerializedEditorState;
  durationSec: number;
}

export interface ExportVideoResult {
  storageKey: string;
}

interface PoolEntry {
  browser: RenderBrowser;
  inUse: boolean;
}

export class HeadlessRenderer {
  private readonly browserFactory: BrowserFactory;
  private readonly objectStorage: ObjectStorage;
  private readonly rendererBaseUrl: string;
  private readonly poolSize: number;
  private readonly pageTimeoutMs: number;

  // Browser pool: fixed-size, lazily populated. Each entry tracks
  // whether it's checked out by an in-flight export. acquire() finds a
  // free entry (or creates one up to poolSize) or awaits a release.
  // pendingAcquires counts in-flight browserFactory() calls so concurrent
  // acquires don't all see the same `pool.length < poolSize` before the
  // first push lands — without this counter, N parallel calls each
  // spawn a browser and the pool exceeds poolSize.
  private readonly pool: PoolEntry[] = [];
  private readonly waiters: Array<(browser: RenderBrowser) => void> = [];
  private pendingAcquires = 0;
  private closed = false;

  constructor(deps: HeadlessRendererDeps) {
    this.browserFactory = deps.browserFactory;
    this.objectStorage = deps.objectStorage;
    this.rendererBaseUrl = deps.rendererBaseUrl;
    this.poolSize = deps.poolSize ?? 4;
    this.pageTimeoutMs = deps.pageTimeoutMs ?? 60_000;
  }

  async exportVideo(params: ExportVideoParams): Promise<ExportVideoResult> {
    if (this.closed) {
      throw new Error("HeadlessRenderer.exportVideo: renderer is closed");
    }

    const browser = await this.acquire();
    try {
      const page = await browser.newPage();
      try {
        const url = this.buildRendererUrl(params);
        await page.goto(url, { timeout: this.pageTimeoutMs });
        // The page.evaluate body is the renderer's responsibility
        // (Phase 3.3 deliverable). The renderer must drive its internal
        // playback + recording (e.g. canvas + MediaRecorder) and yield
        // the final bytes via this contract. Until the renderer module
        // exists, this evaluate call returns whatever the test mock
        // provides — there is no "real" renderer to call against.
        const bytes = await page.evaluate<Uint8Array>(async () => {
          // Typed as Uint8Array; the renderer's static build will
          // attach a function on window that returns the recorded
          // blob bytes. Documented as TODO until the contract solidifies.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = globalThis as unknown as { __chatcutRender?: () => Promise<Uint8Array> };
          if (typeof w.__chatcutRender !== "function") {
            throw new Error(
              "HeadlessRenderer: window.__chatcutRender is not defined — the renderer module (plan §3.3) has not been wired yet.",
            );
          }
          return w.__chatcutRender();
        });

        const storageKey = await this.objectStorage.upload(Buffer.from(bytes), {
          contentType: "video/mp4",
          prefix: `previews/${params.explorationId}`,
        });
        return { storageKey };
      } finally {
        await page.close();
      }
    } finally {
      this.release(browser);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = this.pool.splice(0, this.pool.length);
    await Promise.all(entries.map((e) => e.browser.close()));
  }

  private buildRendererUrl(params: ExportVideoParams): string {
    const u = new URL(this.rendererBaseUrl);
    u.searchParams.set("explorationId", params.explorationId);
    u.searchParams.set("candidateId", params.candidateId);
    u.searchParams.set("durationSec", String(params.durationSec));
    // Timeline snapshot is potentially large — pass it as a base64
    // payload rather than risk URL length limits. Renderer side
    // decodes via atob+JSON.parse. For very large snapshots a future
    // refactor can pre-upload the snapshot to R2 and pass the storage
    // key here instead.
    u.searchParams.set(
      "timelineB64",
      Buffer.from(JSON.stringify(params.timelineSnapshot)).toString("base64"),
    );
    return u.toString();
  }

  private async acquire(): Promise<RenderBrowser> {
    // Prefer a free existing browser
    const free = this.pool.find((e) => !e.inUse);
    if (free) {
      free.inUse = true;
      return free.browser;
    }
    // Pool not yet at capacity (counting in-flight creations) — spawn.
    // The synchronous pendingAcquires++ reserves the slot before the
    // await so concurrent acquires can't all race past the cap.
    if (this.pool.length + this.pendingAcquires < this.poolSize) {
      this.pendingAcquires++;
      try {
        const browser = await this.browserFactory();
        this.pool.push({ browser, inUse: true });
        return browser;
      } finally {
        this.pendingAcquires--;
      }
    }
    // At capacity — wait for a release.
    return new Promise<RenderBrowser>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(browser: RenderBrowser): void {
    // Hand off to a waiter if one is queued (browser stays inUse for them)
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(browser);
      return;
    }
    // Otherwise mark the entry free
    const entry = this.pool.find((e) => e.browser === browser);
    if (entry) entry.inUse = false;
  }
}
