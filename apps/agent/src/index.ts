import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { SkillLoader } from "./skills/loader.js";

async function main() {
  // Load skill contracts before creating the app (requires async I/O)
  const skillLoader = new SkillLoader(null); // null = preset-only mode for now
  const skillContracts = await skillLoader.loadAllSkillContracts(
    "master",
    {},
    {
      availableTools: [], // Will be populated with real tool names in production
      defaultModel: "claude-opus-4-6",
    },
  );

  const app = createApp({ skillContracts });
  const port = parseInt(process.env.PORT || "4000");

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`ChatCut Agent Service running on http://localhost:${info.port}`);
    if (skillContracts.length > 0) {
      console.log(`  Loaded ${skillContracts.length} skill contract(s)`);
    }
  });
}

main();
