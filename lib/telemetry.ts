import type { TelemetrySettings } from "ai";
import type { AttributeValue } from "@opentelemetry/api";
import { appConfig } from "./config";

const isEnabled = Boolean(appConfig.ai.enableTelemetry);

export const baseTelemetry: TelemetrySettings = {
  isEnabled,
  functionId: "slack-hubspot-agent",
};

export function telemetryFor(
  step: string,
  metadata: Record<string, AttributeValue> = {}
): TelemetrySettings {
  if (!isEnabled) return { isEnabled: false };
  return {
    ...baseTelemetry,
    functionId: `slack-hubspot-agent/${step}`,
    metadata,
  };
}
