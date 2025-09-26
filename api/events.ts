import type { SlackEvent } from "@slack/web-api";
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from "../lib/handle-messages";
import { waitUntil } from "@vercel/functions";
import { handleNewAppMention } from "../lib/handle-app-mention";
import { verifyRequest, getBotId } from "../lib/slack-utils";
import { debugLog } from "../lib/logger";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody);
    const requestType = payload.type as "url_verification" | "event_callback";

    // See https://api.slack.com/events/url_verification
    if (requestType === "url_verification") {
      debugLog("slack.events", "URL verification リクエストを受信", {
        requestType,
      });
      return new Response(payload.challenge, { status: 200 });
    }

    const verificationResult = await verifyRequest({
      requestType,
      request,
      rawBody,
    });
    if (verificationResult) {
      debugLog("slack.events", "署名検証が失敗しました", {
        requestType,
      });
      return verificationResult; // This will be an error response if verification failed
    }

    const botUserId = await getBotId();
    const event = payload.event as SlackEvent;
    const teamIdCandidate =
      payload.team_id ?? (event as { team?: string }).team ?? "";
    const eventTimestamp =
      (event as { event_ts?: string }).event_ts ??
      (typeof payload.event_time === "number"
        ? String(payload.event_time)
        : payload.event_time ?? String(Date.now()));

    const envelope = {
      teamId: teamIdCandidate as string,
      eventId: (
        payload.event_id && typeof payload.event_id === "string"
          ? payload.event_id
          : `${payload.type}:${eventTimestamp}`
      ) as string,
    };

    debugLog("slack.events", "イベント受信", {
      type: event.type,
      teamId: envelope.teamId,
      eventId: envelope.eventId,
    });

    if (event.type === "app_mention") {
      debugLog("slack.events", "app_mention をバックグラウンド処理", {
        threadTs: (event as { thread_ts?: string }).thread_ts,
        channel: (event as { channel?: string }).channel,
      });
      waitUntil(handleNewAppMention(event, botUserId, envelope));
    }

    if (event.type === "assistant_thread_started") {
      debugLog("slack.events", "assistant_thread_started を処理", {
        channel: (event as { channel?: string }).channel,
      });
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

    debugLog("slack.events", "イベント処理完了", {
      type: event.type,
    });
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
