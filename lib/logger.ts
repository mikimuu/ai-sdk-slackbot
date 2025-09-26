export function debugLog(
  context: string,
  message: string,
  extra?: Record<string, unknown>
) {
  const flag = process.env.DEBUG_LOGGING;
  const enabled = typeof flag === "string" && /^(1|true|yes)$/i.test(flag.trim());
  if (!enabled) return;

  if (extra && Object.keys(extra).length > 0) {
    console.debug(`[${context}] ${message}`, extra);
  } else {
    console.debug(`[${context}] ${message}`);
  }
}
