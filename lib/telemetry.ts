import type { TelemetrySettings } from "ai";
import { appConfig } from "./config";

const isEnabled = Boolean(appConfig.ai.enableTelemetry);

export const baseTelemetry: TelemetrySettings = {
  isEnabled,
  functionId: "slack-hubspot-agent",
};

export function telemetryFor(
  step: string,
  metadata: Record<string, unknown> = {}
): TelemetrySettings {
  if (!isEnabled) return { isEnabled: false };
  return {
    ...baseTelemetry,
    functionId: `slack-hubspot-agent/${step}`,
    metadata: metadata as TelemetrySettings["metadata"],
  };
}
