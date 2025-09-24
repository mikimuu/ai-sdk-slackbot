import fs from "fs";
import path from "path";

async function main() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#")) continue;
      const [key, ...rest] = line.split("=");
      if (!key) continue;
      const value = rest.join("=").trim();
      if (!process.env[key]) {
        process.env[key] = value.replace(/^"|"$/g, "");
      }
    }
  }

  const requiredDefaults: Record<string, string> = {
    SLACK_SIGNING_SECRET: "test-signing-secret",
    SLACK_BOT_TOKEN: "xoxb-test-bot-token",
    REDIS_REST_URL: "https://example.com",
    REDIS_REST_TOKEN: "test-redis-token",
    HUBSPOT_PRIVATE_APP_TOKEN: "test-hubspot-token",
    POSTGRES_URL: "postgres://user:password@localhost:5432/test",
  };

  for (const [key, value] of Object.entries(requiredDefaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  const { listZapierTools, executeZapierTool } = await import("../lib/zapier-mcp");

  if (!process.env.ZAPIER_MCP_URL) {
    throw new Error("ZAPIER_MCP_URL is not set");
  }

  console.log("Zapier MCP URL:", process.env.ZAPIER_MCP_URL);

  console.log("Fetching tools...");
  const tools = await listZapierTools();
  console.log("Tools:", tools);

  if (tools.length > 0) {
    const toolName = tools[0];
    console.log(`Executing ${toolName} with empty args (for connectivity test)...`);
    try {
      const result = await executeZapierTool(toolName, {});
      console.log("Result:", result);
    } catch (error) {
      console.error("Execution failed:", error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
