import { Hono } from "hono";

const media = new Hono();

media.post("/finalize", (c) => {
  return c.json({ mediaId: "placeholder" });
});

media.get("/:id", (c) => {
  return c.json({ url: "placeholder" });
});

export { media };
