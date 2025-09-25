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

function isDeprecatedToolName(name: string | undefined) {
  return name ? name.toLowerCase().includes("deprecated") : false;
}

const TOOL_NAME_MAP: Partial<
  Record<
    Intent["action"],
    Partial<Record<Intent["object"], string[]>>
  >
> = {
  read: {
    contact: ["hubspot_find_contact", "hubspot_get_contact"],
    company: ["hubspot_find_company", "hubspot_get_company"],
    deal: ["hubspot_find_deal", "hubspot_get_deal"],
    ticket: ["hubspot_find_ticket", "hubspot_get_ticket"],
    custom: ["hubspot_find_custom_object", "hubspot_get_custom_object"],
  },
  create: {
    contact: ["hubspot_create_contact", "hubspot_create_or_update_contact"],
    company: ["hubspot_create_company"],
    deal: ["hubspot_create_deal"],
    ticket: ["hubspot_create_ticket"],
    custom: ["hubspot_create_custom_object"],
  },
  update: {
    contact: ["hubspot_update_contact", "hubspot_create_or_update_contact"],
    company: ["hubspot_update_company"],
    deal: ["hubspot_update_deal"],
    ticket: ["hubspot_update_ticket"],
    custom: ["hubspot_update_custom_object"],
  },
  upsert: {
    contact: ["hubspot_create_or_update_contact"],
    company: ["hubspot_update_company", "hubspot_create_company"],
    deal: ["hubspot_update_deal", "hubspot_create_deal"],
    ticket: ["hubspot_update_ticket", "hubspot_create_ticket"],
    custom: ["hubspot_update_custom_object", "hubspot_create_custom_object"],
  },
  delete: {
    contact: ["hubspot_remove_contact_from_list"],
    company: ["hubspot_remove_associations"],
    deal: ["hubspot_remove_associations"],
    ticket: ["hubspot_remove_associations"],
    custom: ["hubspot_remove_associations"],
  },
  report: {
    deal: ["hubspot_find_associations"],
  },
};

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

async function initTools(forceRefresh = false) {
  if (!forceRefresh && cachedTools) return cachedTools;

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

  let tools = await initTools();
  let tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    tools = await initTools(true);
    tool = tools.find((t) => t.name === toolName);
  }

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
  return tools
    .filter(
      (tool): tool is ToolDefinition & { name: string } =>
        typeof tool.name === "string" && !isDeprecatedToolName(tool.name)
    )
    .map((tool) => tool.name);
}

export async function ensureZapierToolExists(toolName: string) {
  const normalized = toolName.trim();
  let tools = await initTools();
  let match = tools.find((tool) => tool.name === normalized) ?? null;

  if (!match) {
    tools = await initTools(true);
    match = tools.find((tool) => tool.name === normalized) ?? null;
  }

  if (match && isDeprecatedToolName(match.name)) {
    return null;
  }
  return match;
}

const ACTION_KEYWORDS: Record<Intent["action"], string[]> = {
  read: [
    "get",
    "find",
    "list",
    "search",
    "lookup",
    "retrieve",
    "retrieve",
    "look",
    "fetch",
    "find",
    "lookup",
  ],
  create: ["create", "add", "new", "insert", "add"],
  update: ["update", "edit", "modify", "set", "patch"],
  upsert: ["upsert", "create", "update", "sync"],
  delete: ["delete", "remove", "archive"],
  report: ["report", "summary", "analytics", "export"],
};

const OBJECT_KEYWORDS: Record<Intent["object"], string[]> = {
  contact: ["contact", "person", "lead", "customer"],
  company: ["company", "organization", "account", "business"],
  deal: ["deal", "opportunity", "pipeline", "sales"],
  ticket: ["ticket", "case", "issue"],
  custom: ["custom", "object"],
};

export async function findZapierToolForIntent(intent: Intent) {
  const attemptResolve = (toolset: ToolDefinition[]) => {
    const normalizedTools = toolset.filter(
      (tool): tool is ToolDefinition & { name: string } =>
        typeof tool.name === "string" && !isDeprecatedToolName(tool.name)
    );

    const preferredNames =
      TOOL_NAME_MAP[intent.action]?.[intent.object] ?? [];
    for (const candidate of preferredNames) {
      const match = normalizedTools.find(
        (tool) => typeof tool.name === "string" && tool.name === candidate
      );
      if (match) {
        return { toolName: match.name } as const;
      }
    }

    const actionKeywords = ACTION_KEYWORDS[intent.action] ?? [];
    const objectKeywords = OBJECT_KEYWORDS[intent.object] ?? [];

    let bestMatch: { tool: ToolDefinition; score: number } | null = null;

    for (const tool of normalizedTools) {
      const name =
        typeof tool.name === "string" ? tool.name.toLowerCase() : "";
      const description =
        typeof tool.description === "string"
          ? tool.description.toLowerCase()
          : "";
      const displayName =
        typeof tool.displayName === "string"
          ? tool.displayName.toLowerCase()
          : "";
      const text = `${name} ${displayName} ${description}`;

      let score = 0;

      if (text.includes("hubspot")) {
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

    if (bestMatch) {
      return { toolName: bestMatch.tool.name } as const;
    }

    const apiRequestTool = normalizedTools.find(
      (tool) => tool.name === "hubspot_api_request_beta"
    );

    return apiRequestTool ? { toolName: apiRequestTool.name } : null;
  };

  let tools = await initTools();
  let resolved = attemptResolve(tools);

  if (!resolved) {
    tools = await initTools(true);
    resolved = attemptResolve(tools);
  }

  return resolved;
}
