import { Hono } from "hono";
import type { ObjectStorage } from "../services/object-storage.js";

function createMediaRouter(deps: { objectStorage?: ObjectStorage } = {}): Hono {
  const { objectStorage } = deps;
  const router = new Hono();

  router.post("/finalize", async (c) => {
    if (objectStorage) {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const storageKey = body.storageKey as string | undefined;
      if (!storageKey) {
        return c.json({ error: "storageKey is required" }, 400);
      }
      const url = await objectStorage.getSignedUrl(storageKey);
      return c.json({ mediaId: storageKey, url });
    }
    return c.json({ mediaId: "placeholder" });
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (objectStorage) {
      const url = await objectStorage.getSignedUrl(id);
      return c.json({ url });
    }
    return c.json({ url: "placeholder" });
  });

  return router;
}

// Default no-deps instance for backward compatibility
const media = createMediaRouter();

export { media, createMediaRouter };
