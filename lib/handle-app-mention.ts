import crypto from "crypto";
import { AppMentionEvent } from "@slack/web-api";
import {
  DONE_REACTION,
  IN_PROGRESS_REACTION,
  client,
  getThread,
} from "./slack-utils";
import {
  clearIdempotency,
  ensureIdempotency,
  withLock,
} from "./redis";
import { runSlackWorkflow } from "./generate-response";
import { executionStore } from "./durable-store";
import { SlackEnvelope } from "./types";

export async function handleNewAppMention(
  event: AppMentionEvent,
  botUserId: string,
  envelope: SlackEnvelope
) {
  if (event.bot_id || event.bot_id === botUserId || event.bot_profile) {
    return;
  }

  const teamId = envelope.teamId || event.team;
  if (!teamId) {
    console.warn("Missing teamId on app mention event");
    return;
  }

  const threadTs = event.thread_ts ?? event.ts;
  const reactionTarget = event.ts;
  const idempotencyKey = `${teamId}:${envelope.eventId}:${event.event_ts}`;

  const shouldProcess = await ensureIdempotency(idempotencyKey);
  if (!shouldProcess) {
    console.log("Duplicate Slack event detected; skipping execution");
    return;
  }

  let inProgressReactionActive = false;

  if (reactionTarget) {
    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: reactionTarget,
        name: IN_PROGRESS_REACTION,
      });
      inProgressReactionActive = true;
    } catch (error) {
      console.error("Failed to add in-progress reaction", error);
    }
  }

  const jobId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  try {
    const lockKey = `thread:${teamId}:${threadTs}`;
    const lockResult = await withLock(lockKey, async () => {
      await executionStore.createJob({
        id: jobId,
        slackTeamId: teamId,
        slackChannelId: event.channel,
        slackThreadTs: threadTs,
        slackEventId: envelope.eventId,
        status: "running",
        lastError: null,
      });

      const messages = threadTs
        ? await getThread(event.channel, threadTs, botUserId)
        : [{ role: "user", content: sanitizeMention(event.text, botUserId) }];

      const workflowResult = await runSlackWorkflow({
        jobId,
        requestId,
        messages,
        latestUserMessage: event.text,
        slack: {
          teamId,
          channelId: event.channel,
          threadTs,
          eventTs: event.event_ts,
          eventId: envelope.eventId,
          userId: event.user,
        },
      });

      await postWorkflowResult(event.channel, threadTs, workflowResult);
    });

    if (!lockResult.ok) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "別の処理が進行中のため、少し待ってから再度お試しください。",
      });
    }

    if (reactionTarget && inProgressReactionActive) {
      try {
        await client.reactions.remove({
          channel: event.channel,
          timestamp: reactionTarget,
          name: IN_PROGRESS_REACTION,
        });
      } catch (error) {
        console.error("Failed to remove in-progress reaction", error);
      }
      inProgressReactionActive = false;
    }

    if (reactionTarget) {
      try {
        await client.reactions.add({
          channel: event.channel,
          timestamp: reactionTarget,
          name: DONE_REACTION,
        });
      } catch (error) {
        console.error("Failed to add done reaction", error);
      }
    }
  } catch (error) {
    console.error("Error while handling app mention", error);

    if (reactionTarget && inProgressReactionActive) {
      try {
        await client.reactions.remove({
          channel: event.channel,
          timestamp: reactionTarget,
          name: IN_PROGRESS_REACTION,
        });
      } catch (removeError) {
        console.error("Failed to remove in-progress reaction after error", removeError);
      }
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "申し訳ありません。エラーが発生しました。しばらくしてからもう一度お試しください。",
    });
  } finally {
    await clearIdempotency(idempotencyKey);
  }
}

function sanitizeMention(text: string, botUserId: string) {
  if (!text) return text;
  return text.replace(`<@${botUserId}>`, "").trim();
}

async function postWorkflowResult(
  channel: string,
  threadTs: string,
  result: Awaited<ReturnType<typeof runSlackWorkflow>>
) {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: result.text,
    unfurl_links: false,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: result.text,
        },
      },
      ...(result.intent
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Intent: \`${result.intent.action} ${result.intent.object}\` (${result.status})`,
                },
              ],
            },
          ]
        : []),
    ],
  });
}
