import crypto from "crypto";
import type {
  AppMentionEvent,
  ContextBlock,
  KnownBlock,
  MrkdwnElement,
  SectionBlock,
} from "@slack/web-api";
import type { CoreMessage, CoreUserMessage } from "ai";
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
import { debugLog } from "./logger";

export async function handleNewAppMention(
  event: AppMentionEvent,
  botUserId: string,
  envelope: SlackEnvelope
) {
  if (event.bot_id || event.bot_id === botUserId || event.bot_profile) {
    debugLog("slack.app_mention", "ボットからのメッセージのため無視", {
      botId: event.bot_id,
    });
    return;
  }

  const teamId = envelope.teamId || event.team;
  const userId = event.user;
  if (!userId) {
    console.warn("Missing user on app mention event");
    return;
  }
  if (!teamId) {
    console.warn("Missing teamId on app mention event");
    return;
  }

  const rawThreadTs = event.thread_ts ?? event.ts;
  if (!rawThreadTs) {
    console.warn("Missing thread timestamp on app mention event");
    return;
  }
  const threadTs = rawThreadTs;
  const reactionTarget = event.ts ?? threadTs;
  const eventTimestamp = event.event_ts ?? event.ts ?? threadTs;
  const idempotencyKey = `${teamId}:${envelope.eventId}:${eventTimestamp}`;

  const shouldProcess = await ensureIdempotency(idempotencyKey);
  if (!shouldProcess) {
    console.log("Duplicate Slack event detected; skipping execution");
    debugLog("slack.app_mention", "重複イベントをスキップ", {
      idempotencyKey,
    });
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
      debugLog("slack.app_mention", "リアクションを追加", {
        reaction: IN_PROGRESS_REACTION,
        channel: event.channel,
        timestamp: reactionTarget,
      });
    } catch (error) {
      console.error("Failed to add in-progress reaction", error);
    }
  }

  const jobId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  debugLog("slack.app_mention", "ジョブを初期化", {
    jobId,
    requestId,
    threadTs,
  });

  try {
    const lockKey = `thread:${teamId}:${threadTs}`;
    const lockResult = await withLock(lockKey, async () => {
      debugLog("slack.app_mention", "ロックを取得", {
        lockKey,
      });
      await executionStore.createJob({
        id: jobId,
        slackTeamId: teamId,
        slackChannelId: event.channel,
        slackThreadTs: threadTs,
        slackEventId: envelope.eventId,
        status: "running",
        lastError: null,
      });

      const messages: CoreMessage[] = threadTs
        ? await getThread(event.channel, threadTs, botUserId)
        : [
            {
              role: "user",
              content: sanitizeMention(event.text ?? "", botUserId),
            } as CoreUserMessage,
          ];

      const workflowResult = await runSlackWorkflow({
        jobId,
        requestId,
        messages,
        latestUserMessage: event.text ?? "",
        slack: {
          teamId,
          channelId: event.channel,
          threadTs,
          eventTs: eventTimestamp,
          eventId: envelope.eventId,
          userId,
        },
      });

      await postWorkflowResult(event.channel, threadTs, workflowResult);
      debugLog("slack.app_mention", "ワークフロー完了", {
        jobId,
        status: workflowResult.status,
      });
    });

    if (!lockResult.ok) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "別の処理が進行中のため、少し待ってから再度お試しください。",
      });
      debugLog("slack.app_mention", "ロック取得に失敗", {
        lockKey,
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
    debugLog("slack.app_mention", "ワークフロー中にエラー", {
      jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await clearIdempotency(idempotencyKey);
    debugLog("slack.app_mention", "冪等性キーを解放", {
      idempotencyKey,
    });
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
    blocks: buildResultBlocks(result),
  });
}

function buildResultBlocks(result: Awaited<ReturnType<typeof runSlackWorkflow>>) {
  const sectionBlock: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: result.text,
    },
  };

  const blocks: KnownBlock[] = [sectionBlock];

  if (result.intent) {
    const contextBlock: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Intent: \`${result.intent.action} ${result.intent.object}\` (${result.status})`,
        } as MrkdwnElement,
      ],
    };

    blocks.push(contextBlock);
  }

  return blocks;
}
