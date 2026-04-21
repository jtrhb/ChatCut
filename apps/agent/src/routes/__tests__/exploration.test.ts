import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createExplorationRouter } from "../exploration.js";
import type { ExplorationLookup } from "../../services/exploration-lookup.js";
import type { ObjectStorage } from "../../services/object-storage.js";

function fakeStorage(opts?: { signedUrl?: string; throws?: Error }) {
  return {
    getSignedUrl: vi.fn(async () => {
      if (opts?.throws) throw opts.throws;
      return opts?.signedUrl ?? "https://r2.example/signed";
    }),
  } as unknown as ObjectStorage;
}

function fakeLookup(opts?: {
  state?: Awaited<ReturnType<ExplorationLookup["getPreviewState"]>>;
  throws?: Error;
}): ExplorationLookup {
  return {
    getPreviewState: vi.fn(async () => {
      if (opts?.throws) throw opts.throws;
      return opts?.state ?? null;
    }),
  };
}

function mount(deps: Parameters<typeof createExplorationRouter>[0]): Hono {
  const app = new Hono();
  app.route("/exploration", createExplorationRouter(deps));
  return app;
}

describe("/exploration/:explorationId/preview/:candidateId", () => {
  // ── 503 paths ──────────────────────────────────────────────────────────

  it("503 when objectStorage missing", async () => {
    const app = mount({ lookup: fakeLookup() });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("object_storage_unavailable");
  });

  it("503 when lookup missing", async () => {
    const app = mount({ objectStorage: fakeStorage() });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("exploration_lookup_unavailable");
  });

  it("503 when lookup throws (DB down)", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({ throws: new Error("connection refused") }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("lookup_failed");
    expect(body.message).toContain("connection refused");
  });

  it("503 when signing throws", async () => {
    const app = mount({
      objectStorage: fakeStorage({ throws: new Error("R2 down") }),
      lookup: fakeLookup({
        state: {
          previewStorageKeys: { c1: "previews/e1/c1.mp4" },
          previewRenderFailures: null,
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("signing_failed");
  });

  // ── 404 paths ──────────────────────────────────────────────────────────

  it("404 unknown_exploration when row not found", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({ state: null }),
    });
    const res = await app.request("/exploration/missing/preview/c1");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("unknown_exploration");
  });

  it("404 not_ready when row exists but candidate has no key or failure", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({
        state: {
          previewStorageKeys: { otherCand: "previews/e1/other.mp4" },
          previewRenderFailures: null,
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_ready");
  });

  // ── 422 path ───────────────────────────────────────────────────────────

  it("422 render_failed with message + ts when failure recorded", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({
        state: {
          previewStorageKeys: null,
          previewRenderFailures: {
            c1: { message: "melt subprocess crashed", ts: "2026-04-21T05:00Z" },
          },
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("render_failed");
    expect(body.message).toBe("melt subprocess crashed");
    expect(body.ts).toBe("2026-04-21T05:00Z");
    expect(body.synthesized).toBeUndefined();
  });

  it("422 surfaces synthesized flag for poll-timeout failures", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({
        state: {
          previewStorageKeys: null,
          previewRenderFailures: {
            c1: {
              message: "polling timeout after 90000ms",
              ts: "2026-04-21T05:00Z",
              synthesized: true,
            },
          },
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.synthesized).toBe(true);
  });

  it("422 wins over success when both maps somehow have entries (race)", async () => {
    const app = mount({
      objectStorage: fakeStorage(),
      lookup: fakeLookup({
        state: {
          previewStorageKeys: { c1: "previews/e1/c1.mp4" },
          previewRenderFailures: {
            c1: { message: "stale failure", ts: "2026-04-21T05:00Z" },
          },
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(422);
  });

  // ── 200 path ───────────────────────────────────────────────────────────

  it("200 returns signed URL when storage key present", async () => {
    const storage = fakeStorage({ signedUrl: "https://r2.example/signed?sig=xyz" });
    const app = mount({
      objectStorage: storage,
      lookup: fakeLookup({
        state: {
          previewStorageKeys: { c1: "previews/e1/c1.mp4" },
          previewRenderFailures: null,
        },
      }),
    });
    const res = await app.request("/exploration/e1/preview/c1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      explorationId: "e1",
      candidateId: "c1",
      url: "https://r2.example/signed?sig=xyz",
      storageKey: "previews/e1/c1.mp4",
    });
    expect(storage.getSignedUrl).toHaveBeenCalledWith(
      "previews/e1/c1.mp4",
      24 * 60 * 60,
    );
  });

  it("respects custom signedUrlTtlSec", async () => {
    const storage = fakeStorage();
    const app = mount({
      objectStorage: storage,
      lookup: fakeLookup({
        state: {
          previewStorageKeys: { c1: "previews/e1/c1.mp4" },
          previewRenderFailures: null,
        },
      }),
      signedUrlTtlSec: 3600,
    });
    await app.request("/exploration/e1/preview/c1");
    expect(storage.getSignedUrl).toHaveBeenCalledWith(
      "previews/e1/c1.mp4",
      3600,
    );
  });
});
