import { serve } from "@hono/node-server";
import { createApp } from "./server.js";

const app = createApp();
const port = parseInt(process.env.PORT || "4000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ChatCut Agent Service running on http://localhost:${info.port}`);
});
