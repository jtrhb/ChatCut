import { describe, it, expect, vi } from "vitest";
import {
  HeadlessRenderer,
  type RenderBrowser,
  type RenderPage,
  type BrowserFactory,
} from "../headless-renderer.js";
import type { ObjectStorage } from "../object-storage.js";

function makeMockPage(opts: {
  evaluateResult?: Uint8Array;
  evaluateThrows?: Error;
} = {}): RenderPage & {
  gotoSpy: ReturnType<typeof vi.fn>;
  evaluateSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const gotoSpy = vi.fn(async (_url: string, _opts?: { timeout?: number }) => {});
  const evaluateSpy = vi.fn(async () => {
    if (opts.evaluateThrows) throw opts.evaluateThrows;
    return opts.evaluateResult ?? new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  });
  const closeSpy = vi.fn(async () => {});
  return Object.assign(
    {
      goto: gotoSpy,
      evaluate: evaluateSpy,
      close: closeSpy,
    },
    { gotoSpy, evaluateSpy, closeSpy },
  ) as any;
}

function makeMockBrowser(opts: {
  page?: ReturnType<typeof makeMockPage>;
  closeSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const page = opts.page ?? makeMockPage();
  const closeSpy = opts.closeSpy ?? vi.fn(async () => {});
  const newPageSpy = vi.fn(async () => page);
  const browser: RenderBrowser = {
    newPage: newPageSpy,
    close: closeSpy,
  };
  return Object.assign(browser, { newPageSpy, closeSpy, page });
}

function makeMockObjectStorage(opts: { storageKey?: string } = {}) {
  const uploadSpy = vi.fn(async () => opts.storageKey ?? "previews/explo-1/abc.mp4");
  const getSignedUrlSpy = vi.fn(async () => "https://signed.example.com/url");
  return {
    objectStorage: { upload: uploadSpy, getSignedUrl: getSignedUrlSpy } as unknown as ObjectStorage,
    uploadSpy,
    getSignedUrlSpy,
  };
}

const BASE_PARAMS = {
  explorationId: "explo-1",
  candidateId: "cand-A",
  timelineSnapshot: { project: null, scenes: [], activeSceneId: null },
  durationSec: 5,
};

describe("HeadlessRenderer", () => {
  describe("exportVideo()", () => {
    it("navigates to a templated URL containing explorationId + candidateId, then uploads the rendered bytes", async () => {
      const browser = makeMockBrowser();
      const factory: BrowserFactory = vi.fn(async () => browser);
      const { objectStorage, uploadSpy } = makeMockObjectStorage({ storageKey: "previews/explo-1/cand-A.mp4" });
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
      });

      const result = await renderer.exportVideo(BASE_PARAMS);

      expect(result.storageKey).toBe("previews/explo-1/cand-A.mp4");
      expect(browser.page.gotoSpy).toHaveBeenCalledTimes(1);
      const navUrl = browser.page.gotoSpy.mock.calls[0][0] as string;
      expect(navUrl).toContain("https://renderer.example.com");
      expect(navUrl).toContain("explorationId=explo-1");
      expect(navUrl).toContain("candidateId=cand-A");
      // Upload uses the previews/{explorationId}/ prefix per spec
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      const uploadOpts = uploadSpy.mock.calls[0][1];
      expect(uploadOpts.prefix).toBe("previews/explo-1");
      expect(uploadOpts.contentType).toMatch(/video/);
    });

    it("closes the page even when evaluate throws (cleanup invariant)", async () => {
      const page = makeMockPage({ evaluateThrows: new Error("renderer crashed") });
      const browser = makeMockBrowser({ page });
      const factory: BrowserFactory = vi.fn(async () => browser);
      const { objectStorage } = makeMockObjectStorage();
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
      });

      await expect(renderer.exportVideo(BASE_PARAMS)).rejects.toThrow("renderer crashed");
      expect(page.closeSpy).toHaveBeenCalledTimes(1);
    });

    it("releases the browser back to the pool after a successful export (sequential exports reuse the browser)", async () => {
      let factoryCalls = 0;
      const browser = makeMockBrowser();
      const factory: BrowserFactory = vi.fn(async () => {
        factoryCalls++;
        return browser;
      });
      const { objectStorage } = makeMockObjectStorage();
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
        poolSize: 1,
      });

      await renderer.exportVideo(BASE_PARAMS);
      await renderer.exportVideo({ ...BASE_PARAMS, candidateId: "cand-B" });

      // Pool size 1 + sequential calls → factory invoked exactly once.
      expect(factoryCalls).toBe(1);
      // Browser was reused across two exports.
      expect(browser.newPageSpy).toHaveBeenCalledTimes(2);
    });

    it("releases the browser back to the pool even when export fails (no leak)", async () => {
      let factoryCalls = 0;
      const failingPage = makeMockPage({ evaluateThrows: new Error("fail-1") });
      const okPage = makeMockPage();
      const calls = [failingPage, okPage];
      let i = 0;
      const browser: RenderBrowser & { newPageSpy: ReturnType<typeof vi.fn> } = {
        newPage: vi.fn(async () => calls[i++]),
        close: vi.fn(),
      } as any;
      browser.newPageSpy = browser.newPage as ReturnType<typeof vi.fn>;
      const factory: BrowserFactory = vi.fn(async () => {
        factoryCalls++;
        return browser;
      });
      const { objectStorage } = makeMockObjectStorage();
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
        poolSize: 1,
      });

      await expect(renderer.exportVideo(BASE_PARAMS)).rejects.toThrow();
      // Subsequent export must succeed — browser was returned to the pool
      // even though the previous export errored.
      const result = await renderer.exportVideo({ ...BASE_PARAMS, candidateId: "cand-C" });
      expect(result.storageKey).toBeDefined();
      expect(factoryCalls).toBe(1);
    });

    it("respects poolSize: more concurrent calls than browsers spawn additional browsers up to the cap", async () => {
      const browsersCreated: ReturnType<typeof makeMockBrowser>[] = [];
      const factory: BrowserFactory = vi.fn(async () => {
        const b = makeMockBrowser();
        browsersCreated.push(b);
        return b;
      });
      const { objectStorage } = makeMockObjectStorage();
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
        poolSize: 2,
      });

      // Three concurrent exports — pool size 2, so 2 browsers spawn and the
      // 3rd export waits then reuses one.
      await Promise.all([
        renderer.exportVideo(BASE_PARAMS),
        renderer.exportVideo({ ...BASE_PARAMS, candidateId: "cand-B" }),
        renderer.exportVideo({ ...BASE_PARAMS, candidateId: "cand-C" }),
      ]);

      expect(browsersCreated.length).toBeLessThanOrEqual(2);
      expect(browsersCreated.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("close()", () => {
    it("closes every browser in the pool", async () => {
      const b1 = makeMockBrowser();
      const b2 = makeMockBrowser();
      const queue = [b1, b2];
      const factory: BrowserFactory = vi.fn(async () => queue.shift()!);
      const { objectStorage } = makeMockObjectStorage();
      const renderer = new HeadlessRenderer({
        browserFactory: factory,
        objectStorage,
        rendererBaseUrl: "https://renderer.example.com",
        poolSize: 2,
      });

      await Promise.all([
        renderer.exportVideo(BASE_PARAMS),
        renderer.exportVideo({ ...BASE_PARAMS, candidateId: "cand-B" }),
      ]);
      await renderer.close();

      expect(b1.closeSpy).toHaveBeenCalledTimes(1);
      expect(b2.closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
