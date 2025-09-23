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
import { generateResponse } from "./generate-response";

export async function assistantThreadMessage(
  event: AssistantThreadStartedEvent,
) {
  const { channel_id, thread_ts } = event.assistant_thread;
  console.log(`Thread started: ${channel_id} ${thread_ts}`);
  console.log(JSON.stringify(event));

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
) {
  if (
    event.bot_id ||
    event.bot_id === botUserId ||
    event.bot_profile ||
    !event.thread_ts
  )
    return;

  const { thread_ts, channel } = event;
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

  const messages = await getThread(channel, thread_ts, botUserId);

  try {
    const assistantResponse = await generateResponse(messages);
    await client.chat.postMessage({
      channel: channel,
      thread_ts: thread_ts,
      text: assistantResponse,
      unfurl_links: false,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: assistantResponse,
          },
        },
      ],
    });

    if (messageTs) {
      if (inProgressReactionActive) {
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
    await updateStatus("");
  }
}
