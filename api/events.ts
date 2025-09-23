import type { SlackEvent } from "@slack/web-api";
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from "../lib/handle-messages";
import { waitUntil } from "@vercel/functions";
import { handleNewAppMention } from "../lib/handle-app-mention";
import { verifyRequest, getBotId } from "../lib/slack-utils";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody);
    const requestType = payload.type as "url_verification" | "event_callback";

    // See https://api.slack.com/events/url_verification
    if (requestType === "url_verification") {
      return new Response(payload.challenge, { status: 200 });
    }

    const verificationResult = await verifyRequest({
      requestType,
      request,
      rawBody,
    });
    if (verificationResult) {
      return verificationResult; // This will be an error response if verification failed
    }

    const botUserId = await getBotId();
    const event = payload.event as SlackEvent;

    const envelope = {
      teamId: (payload.team_id ?? (event as { team?: string }).team ?? "") as string,
      eventId: (payload.event_id ?? `${payload.type}:${event.event_ts}`) as string,
    };

    if (event.type === "app_mention") {
      waitUntil(handleNewAppMention(event, botUserId, envelope));
    }

    if (event.type === "assistant_thread_started") {
      waitUntil(assistantThreadMessage(event));
    }

    if (
      event.type === "message" &&
      !event.subtype &&
      event.channel_type === "im" &&
      !event.bot_id &&
      !event.bot_profile &&
      event.bot_id !== botUserId
    ) {
      waitUntil(handleNewAssistantMessage(event, botUserId, envelope));
    }

    return new Response("Success!", { status: 200 });
  } catch (error) {
    console.error("Error in POST handler:", error);
    return new Response(
      `Error processing request: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { status: 500 }
    );
  }
}
