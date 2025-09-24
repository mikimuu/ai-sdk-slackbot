import Hubspot from "@hubspot/api-client";
import pRetry from "p-retry";
import { Intent } from "./intent";
import { appConfig } from "./config";
import { cacheJson, getCachedJson } from "./redis";

const hubspotClient = appConfig.hubspot.accessToken
  ? new Hubspot.Client({
      accessToken: appConfig.hubspot.accessToken,
    })
  : null;

type HubSpotObjectType = Intent["object"];

type HubSpotProperty = {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  required: boolean;
  referencedObjectType?: string;
};

type HubSpotObjectHandlers = {
  basicApi: any;
  searchApi?: any;
};

const objectMap: Record<HubSpotObjectType, string> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
  ticket: "tickets",
  custom: "custom",
};

function requireHubSpotClient() {
  if (!hubspotClient) {
    throw new Error("HubSpot の認証情報が設定されていません。");
  }
  return hubspotClient;
}

function getObjectApis(object: HubSpotObjectType): HubSpotObjectHandlers {
  const client = requireHubSpotClient();
  switch (object) {
    case "contact":
      return {
        basicApi: client.crm.contacts.basicApi,
        searchApi: client.crm.contacts.searchApi,
      };
    case "company":
      return {
        basicApi: client.crm.companies.basicApi,
        searchApi: client.crm.companies.searchApi,
      };
    case "deal":
      return {
        basicApi: client.crm.deals.basicApi,
        searchApi: client.crm.deals.searchApi,
      };
    case "ticket":
      return {
        basicApi: client.crm.tickets.basicApi,
        searchApi: client.crm.tickets.searchApi,
      };
    case "custom":
      return {
        basicApi: client.crm.objects.basicApi,
        searchApi: client.crm.objects.searchApi,
      };
    default:
      throw new Error(`Unsupported HubSpot object: ${object}`);
  }
}

async function fetchProperties(object: HubSpotObjectType): Promise<HubSpotProperty[]> {
  const cacheKey = `hs-properties:${object}`;
  const cached = await getCachedJson<HubSpotProperty[]>(cacheKey);
  if (cached) return cached;

  const client = requireHubSpotClient();
  const properties = await client.crm.properties.coreApi.getAll(objectMap[object]);
  const normalized = properties.results.map((property: any) => ({
    name: property.name,
    label: property.label,
    type: property.type,
    fieldType: property.fieldType,
    required: Boolean(property.required),
    referencedObjectType: property.referencedObjectType,
  }));

  await cacheJson(cacheKey, normalized, 60 * 60);
  return normalized;
}

export async function validateIntentAgainstHubSpot(intent: Intent) {
  if (!hubspotClient) {
    return {
      ok: false,
      errors: ["HubSpot Private App Token が設定されていません"],
    };
  }
  const properties = await fetchProperties(intent.object);
  const propertyNames = new Set(properties.map((property) => property.name));
  const errors: string[] = [];

  if (intent.action !== "read") {
    for (const property of properties) {
      if (property.required && !(property.name in intent.fields)) {
        errors.push(`Missing required property ${property.name}`);
      }
    }
  }

  for (const [fieldKey, value] of Object.entries(intent.fields)) {
    if (!propertyNames.has(fieldKey)) {
      errors.push(`Unknown property ${fieldKey}`);
      continue;
    }

    const property = properties.find((prop) => prop.name === fieldKey)!;
    if (value === null || value === undefined) {
      errors.push(`Property ${fieldKey} cannot be null or undefined`);
      continue;
    }

    if (property.type === "number" && typeof value !== "number") {
      errors.push(`Property ${fieldKey} must be a number`);
    }

    if (property.type === "string" && typeof value !== "string") {
      errors.push(`Property ${fieldKey} must be a string`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

const operatorMap: Record<string, string> = {
  eq: "EQ",
  contains: "CONTAINS_TOKEN",
  in: "IN",
  gt: "GT",
  lt: "LT",
};

function buildFilters(intent: Intent) {
  if (!intent.filters.length) return undefined;

  return [
    {
      filters: intent.filters.map((filter) => ({
        propertyName: filter.field,
        operator: operatorMap[filter.op],
        value: Array.isArray(filter.value) ? undefined : filter.value,
        values: Array.isArray(filter.value) ? filter.value : undefined,
      })),
    },
  ];
}

export type HubSpotExecutionOptions = {
  requestId: string;
  traceId?: string;
};

export async function executeIntentWithHubSpot(
  intent: Intent,
  options: HubSpotExecutionOptions
) {
  if (!hubspotClient) {
    throw new Error("HubSpot Private App Token が設定されていません");
  }
  const apis = getObjectApis(intent.object);

  switch (intent.action) {
    case "read":
      if (!apis.searchApi) {
        throw new Error(`Search API not available for object ${intent.object}`);
      }

      return pRetry(
        () =>
          apis.searchApi.doSearch({
            limit: intent.limit,
            after: undefined,
            filterGroups: buildFilters(intent),
            properties: Object.keys(intent.fields ?? {}),
          }),
        {
          retries: 3,
          minTimeout: 500,
          factor: 2,
        }
      );

    case "create":
      return pRetry(
        () =>
          apis.basicApi.create(
            intent.object === "custom"
              ? intent.fields
              : {
                  properties: intent.fields,
                }
          ),
        {
          retries: 3,
          minTimeout: 500,
        }
      );

    case "update": {
      const recordId = String(intent.fields.id ?? intent.fields.recordId);
      if (!recordId) throw new Error("Update intent requires id field");

      const { id, recordId: _recordId, ...properties } = intent.fields;
      return pRetry(
        () => apis.basicApi.update(recordId, { properties }),
        {
          retries: 3,
          minTimeout: 500,
        }
      );
    }

    case "delete": {
      const recordId = String(intent.fields.id ?? intent.fields.recordId);
      if (!recordId) throw new Error("Delete intent requires id field");
      return pRetry(
        () => apis.basicApi.archive(recordId),
        { retries: 3, minTimeout: 500 }
      );
    }

    default:
      throw new Error(`Unsupported HubSpot action: ${intent.action}`);
  }
}

export { hubspotClient };
