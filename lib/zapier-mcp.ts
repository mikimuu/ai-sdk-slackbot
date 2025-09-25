import crypto from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Intent } from "./intent";
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

export async function ensureZapierToolExists(toolName: string) {
  const tools = await initTools();
  return tools.find((tool) => tool.name === toolName) ?? null;
}

const ACTION_KEYWORDS: Record<Intent["action"], string[]> = {
  read: ["get", "find", "list", "search", "lookup", "retrieve"],
  create: ["create", "add", "new", "insert"],
  update: ["update", "edit", "modify", "set", "patch"],
  upsert: ["upsert", "create", "update", "sync"],
  delete: ["delete", "remove", "archive"],
  report: ["report", "summary", "analytics", "export"],
};

const OBJECT_KEYWORDS: Record<Intent["object"], string[]> = {
  contact: ["contact", "person", "lead"],
  company: ["company", "organization", "account"],
  deal: ["deal", "opportunity", "pipeline"],
  ticket: ["ticket", "case", "issue"],
  custom: ["custom", "object"],
};

export async function findZapierToolForIntent(intent: Intent) {
  const tools = await initTools();
  const actionKeywords = ACTION_KEYWORDS[intent.action] ?? [];
  const objectKeywords = OBJECT_KEYWORDS[intent.object] ?? [];

  let bestMatch: { tool: ToolDefinition; score: number } | null = null;

  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const description = (tool.description ?? "").toLowerCase();
    const text = `${name} ${description}`;

    let score = 0;

    if (name.includes("hubspot") || description.includes("hubspot")) {
      score += 4;
    }

    for (const keyword of objectKeywords) {
      if (text.includes(keyword)) {
        score += 3;
        break;
      }
    }

    for (const keyword of actionKeywords) {
      if (text.includes(keyword)) {
        score += 3;
        break;
      }
    }

    if (intent.action === "read" && text.includes("search")) {
      score += 1;
    }

    if (intent.action === "update" && text.includes("property")) {
      score += 1;
    }

    if (score === 0) continue;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { tool, score };
    }
  }

  if (!bestMatch) return null;

  return {
    toolName: bestMatch.tool.name,
  };
}
