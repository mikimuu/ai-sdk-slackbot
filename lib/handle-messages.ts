import crypto from "crypto";
import type {
  AssistantThreadStartedEvent,
  GenericMessageEvent,
} from "@slack/web-api";
import {
  DONE_REACTION,
  IN_PROGRESS_REACTION,
  client,
  getThread,
  updateStatusUtil,
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

export async function assistantThreadMessage(
  event: AssistantThreadStartedEvent,
) {
  const { channel_id, thread_ts } = event.assistant_thread;
  console.log(`Thread started: ${channel_id} ${thread_ts}`);
  console.log(JSON.stringify(event));
  debugLog("slack.assistant_thread", "スレッドが開始されました", {
    channel: channel_id,
    threadTs: thread_ts,
  });

  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: thread_ts,
    text: "こんにちは、リクルーターボットです。採用や人材紹介に関するご相談をお手伝いします。",
  });

  await client.assistant.threads.setSuggestedPrompts({
    channel_id: channel_id,
    thread_ts: thread_ts,
    prompts: [
      {
        title: "求人票のブラッシュアップ",
        message: "シニアバックエンドエンジニア向けの求人票を改善して。",
      },
      {
        title: "候補者への初回メッセージ",
        message: "カスタマーサクセスマネージャー候補に送るスカウト文面を下書きして。",
      },
    ],
  });
}

export async function handleNewAssistantMessage(
  event: GenericMessageEvent,
  botUserId: string,
  envelope: SlackEnvelope
) {
  if (
    event.bot_id ||
    event.bot_id === botUserId ||
    event.bot_profile ||
    !event.thread_ts
  )
    return;

  const { thread_ts, channel } = event;
  const teamId = envelope.teamId || event.team;
  if (!teamId) return;

  const idempotencyKey = `${teamId}:${envelope.eventId}:${event.ts}`;
  const shouldProcess = await ensureIdempotency(idempotencyKey);
  if (!shouldProcess) return;
  debugLog("slack.dm", "新しいメッセージを処理", {
    channel,
    threadTs: thread_ts,
    user: event.user,
  });

  const updateStatus = updateStatusUtil(channel, thread_ts);
  await updateStatus("is thinking...");

  const messageTs = event.ts;
  let inProgressReactionActive = false;

  if (messageTs) {
    try {
      await client.reactions.add({
        channel,
        timestamp: messageTs,
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
    const lockKey = `thread:${teamId}:${thread_ts}`;
    const lockResult = await withLock(lockKey, async () => {
      await executionStore.createJob({
        id: jobId,
        slackTeamId: teamId,
        slackChannelId: channel,
        slackThreadTs: thread_ts,
        slackEventId: envelope.eventId,
        status: "running",
        lastError: null,
      });

      const messages = await getThread(channel, thread_ts, botUserId);

      const workflowResult = await runSlackWorkflow({
        jobId,
        requestId,
        messages,
        latestUserMessage: event.text ?? "",
        slack: {
          teamId,
          channelId: channel,
          threadTs: thread_ts,
          eventTs: event.ts,
          eventId: envelope.eventId,
          userId: event.user ?? "",
        },
      });

      await client.chat.postMessage({
        channel,
        thread_ts: thread_ts,
        text: workflowResult.text,
        unfurl_links: false,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: workflowResult.text,
            },
          },
        ],
      });
      debugLog("slack.dm", "DM ワークフロー完了", {
        jobId,
        status: workflowResult.status,
      });
    });

    if (!lockResult.ok) {
      await client.chat.postMessage({
        channel,
        thread_ts: thread_ts,
        text: "別の処理が進行中です。少し間を置いてから再度お試しください。",
      });
      debugLog("slack.dm", "ロック取得に失敗", { channel, threadTs: thread_ts });
    }

    if (messageTs && inProgressReactionActive) {
      try {
        await client.reactions.remove({
          channel,
          timestamp: messageTs,
          name: IN_PROGRESS_REACTION,
        });
      } catch (error) {
        console.error("Failed to remove in-progress reaction", error);
      }
      inProgressReactionActive = false;
    }

    if (messageTs) {
      try {
        await client.reactions.add({
          channel,
          timestamp: messageTs,
          name: DONE_REACTION,
        });
      } catch (error) {
        console.error("Failed to add done reaction", error);
      }
    }
  } catch (error) {
    if (messageTs && inProgressReactionActive) {
      try {
        await client.reactions.remove({
          channel,
          timestamp: messageTs,
          name: IN_PROGRESS_REACTION,
        });
      } catch (removeError) {
        console.error(
          "Failed to remove in-progress reaction after error",
          removeError,
        );
      }
    }
    throw error;
  } finally {
    await clearIdempotency(idempotencyKey);
    await updateStatus("");
    debugLog("slack.dm", "処理完了", { jobId, channel, threadTs: thread_ts });
  }
}
