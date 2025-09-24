import crypto from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { appConfig } from "./config";

type ToolDefinition = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];

let clientPromise: Promise<Client> | null = null;
let cachedTools: ToolDefinition[] | null = null;

async function getClient() {
  if (!clientPromise) {
    const headers: Record<string, string> = {
      "x-zapier-trace-id": crypto.randomUUID(),
    };

    if (appConfig.zapier.apiKey) {
      headers.Authorization = `Bearer ${appConfig.zapier.apiKey}`;
    }

    const client = new Client(
      {
        name: "slack-hubspot-zapier-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    const transport = new SSEClientTransport(new URL(appConfig.zapier.mcpUrl), {
      requestInit: {
        headers,
      },
    });

    clientPromise = client.connect(transport).then(() => client);
  }

  return clientPromise;
}

async function initTools() {
  if (cachedTools) return cachedTools;

  const client = await getClient();
  const { tools } = await client.listTools();
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
  const client = await getClient();

  const tools = await initTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    throw new Error(`Zapier MCP tool ${toolName} not found`);
  }

  const result = await client.callTool({
    name: toolName,
    arguments: args,
  });

  return {
    toolName,
    result,
  };
}

export async function listZapierTools() {
  const tools = await initTools();
  return tools.map((tool) => tool.name);
}
