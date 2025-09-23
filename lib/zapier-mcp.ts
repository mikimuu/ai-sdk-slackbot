import crypto from "crypto";
import { experimental_createMCPClient } from "ai";
import type { Tool } from "ai";
import { appConfig } from "./config";

let cachedTools: Record<string, Tool<any, any>> | null = null;

async function initTools() {
  if (cachedTools) return cachedTools;

  const client = await experimental_createMCPClient({
    transport: {
      type: "sse",
      url: appConfig.zapier.mcpUrl,
      headers: {
        Authorization: `Bearer ${appConfig.zapier.apiKey}`,
        "x-zapier-trace-id": crypto.randomUUID(),
      },
    },
    name: "slack-hubspot-zapier-mcp",
  });

  const tools = await client.tools();
  cachedTools = tools;
  return tools;
}

export type ZapierToolResult = {
  toolName: string;
  result: unknown;
};

export async function executeZapierTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ZapierToolResult> {
  const tools = await initTools();
  const tool = tools[toolName];

  if (!tool) {
    throw new Error(`Zapier MCP tool ${toolName} not found`);
  }

  const result = await tool.execute(args, {});

  return {
    toolName,
    result,
  };
}

export async function listZapierTools() {
  const tools = await initTools();
  return Object.keys(tools);
}
