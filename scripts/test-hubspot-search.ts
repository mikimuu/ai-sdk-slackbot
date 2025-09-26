import fs from "fs";
import path from "path";

async function main() {
  // 環境変数読み込み
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

  // デフォルト値設定
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

  const { executeZapierTool } = await import("../lib/zapier-mcp");

  if (!process.env.ZAPIER_MCP_URL) {
    throw new Error("ZAPIER_MCP_URL is not set");
  }

  console.log("=== Zapier MCP HubSpot 自然言語検索テスト ===\n");

  // HubSpotコンタクト検索のテスト
  console.log("1. HubSpotコンタクト検索テスト");
  try {
    const result = await executeZapierTool("hubspot_find_contact", {
      instructions: "HubSpotのコンタクトを検索して、最新の10件のレコードを取得してください"
    });
    console.log("✅ 成功:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.log("❌ エラー:", error);
  }

  console.log("\n2. HubSpot会社検索テスト");
  try {
    const result = await executeZapierTool("hubspot_find_company", {
      instructions: "HubSpotの会社レコードを検索して、最新の5件を取得してください"
    });
    console.log("✅ 成功:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.log("❌ エラー:", error);
  }

  console.log("\n3. HubSpotディール検索テスト");
  try {
    const result = await executeZapierTool("hubspot_find_deal", {
      instructions: "HubSpotのディールを検索して、アクティブなディールを5件取得してください"
    });
    console.log("✅ 成功:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.log("❌ エラー:", error);
  }
}

main().catch((error) => {
  console.error("テスト実行エラー:", error);
  process.exit(1);
});
