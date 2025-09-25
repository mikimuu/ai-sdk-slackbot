import crypto from "crypto";
import { CoreMessage } from "ai";
import { WebClient } from "@slack/web-api";
import { appConfig } from "./config";

export const client = new WebClient(appConfig.slack.botToken);

const normalizeReactionName = (value: string | undefined, fallback: string) => {
  if (!value) return fallback;
  const normalized = value
    .trim()
    .replace(/:/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
};

export const IN_PROGRESS_REACTION = normalizeReactionName(
  process.env.SLACK_REACTION_IN_PROGRESS,
  "hourglass_flowing_sand"
);

export const DONE_REACTION = normalizeReactionName(
  process.env.SLACK_REACTION_DONE,
  "white_check_mark"
);

// See https://api.slack.com/authentication/verifying-requests-from-slack
export async function isValidSlackRequest({
  request,
  rawBody,
}: {
  request: Request;
  rawBody: string;
}) {
  // console.log('Validating Slack request')
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const slackSignature = request.headers.get("X-Slack-Signature");
  // console.log(timestamp, slackSignature)

  if (!timestamp || !slackSignature) {
    console.log("Missing timestamp or signature");
    return false;
  }

  // Prevent replay attacks on the order of 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 60 * 5) {
    console.log("Timestamp out of range");
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", appConfig.slack.signingSecret)
    .update(base)
    .digest("hex");
  const computedSignature = `v0=${hmac}`;

  // Debug logging
  console.log("Computed signature:", computedSignature);
  console.log("Slack signature:", slackSignature);

  // Prevent timing attacks
  const computedBuffer = Buffer.from(computedSignature);
  const slackBuffer = Buffer.from(slackSignature);

  // Ensure both buffers have the same length
  if (computedBuffer.length !== slackBuffer.length) {
    console.log("Signature length mismatch");
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, slackBuffer);
}

export const verifyRequest = async ({
  requestType,
  request,
  rawBody,
}: {
  requestType: string;
  request: Request;
  rawBody: string;
}) => {
  console.log("Request type:", requestType);
  console.log("Raw body:", rawBody);

  if (requestType !== "event_callback") {
    return new Response("Invalid request type", { status: 400 });
  }

  const valid = await isValidSlackRequest({ request, rawBody });
  if (!valid) {
    return new Response("Invalid Slack signature", { status: 401 });
  }
};

export const updateStatusUtil = (channel: string, thread_ts: string) => {
  return async (status: string) => {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: thread_ts,
      status: status,
    });
  };
};

export async function getThread(
  channel_id: string,
  thread_ts: string,
  botUserId: string
): Promise<CoreMessage[]> {
  const { messages } = await client.conversations.replies({
    channel: channel_id,
    ts: thread_ts,
    limit: 50,
  });

  // Ensure we have messages

  if (!messages) throw new Error("No messages found in thread");

  const result = messages
    .map((message) => {
      const isBot = !!message.bot_id;
      if (!message.text) return null;

      // For app mentions, remove the mention prefix
      // For IM messages, keep the full text
      let content = message.text;
      if (!isBot && content.includes(`<@${botUserId}>`)) {
        content = content.replace(`<@${botUserId}> `, "");
      }

      return {
        role: isBot ? "assistant" : "user",
        content: content,
      } as CoreMessage;
    })
    .filter((msg): msg is CoreMessage => msg !== null);

  return result;
}

export const getBotId = async () => {
  const { user_id: botUserId } = await client.auth.test();

  if (!botUserId) {
    throw new Error("botUserId is undefined");
  }
  return botUserId;
};
