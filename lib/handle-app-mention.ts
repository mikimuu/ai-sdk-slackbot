import { AppMentionEvent } from "@slack/web-api";
import {
  DONE_REACTION,
  IN_PROGRESS_REACTION,
  client,
  getThread,
} from "./slack-utils";
import { generateResponse } from "./generate-response";

// Removed updateStatusUtil since we're posting directly as replies

export async function handleNewAppMention(
  event: AppMentionEvent,
  botUserId: string,
) {
  console.log("Handling app mention");
  if (event.bot_id || event.bot_id === botUserId || event.bot_profile) {
    console.log("Skipping app mention");
    return;
  }

  const { thread_ts, channel } = event;
  // Remove the initial "is thinking..." message since we'll post directly as a reply

  const reactionTarget = event.ts;
  let inProgressReactionActive = false;

  if (reactionTarget) {
    try {
      await client.reactions.add({
        channel,
        timestamp: reactionTarget,
        name: IN_PROGRESS_REACTION,
      });
      inProgressReactionActive = true;
    } catch (error) {
      console.error("Failed to add in-progress reaction", error);
    }
  }

  try {
    let result: string;

    if (thread_ts) {
      const messages = await getThread(channel, thread_ts, botUserId);
      result = await generateResponse(messages);
    } else {
      result = await generateResponse([{ role: "user", content: event.text }]);
    }

    // Post the response as a reply in the thread
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts, // Reply to the original mention
      text: result,
      unfurl_links: false,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: result,
          },
        },
      ],
    });

    if (reactionTarget) {
      if (inProgressReactionActive) {
        try {
          await client.reactions.remove({
            channel,
            timestamp: reactionTarget,
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
          timestamp: reactionTarget,
          name: DONE_REACTION,
        });
      } catch (error) {
        console.error("Failed to add done reaction", error);
      }
    }
  } catch (error) {
    if (reactionTarget && inProgressReactionActive) {
      try {
        await client.reactions.remove({
          channel,
          timestamp: reactionTarget,
          name: IN_PROGRESS_REACTION,
        });
      } catch (removeError) {
        console.error(
          "Failed to remove in-progress reaction after error",
          removeError,
        );
      }
    }
    
    // Post error message as a reply
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "申し訳ありません。エラーが発生しました。しばらくしてからもう一度お試しください。",
    });
    
    throw error;
  }
}
