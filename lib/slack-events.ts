export interface SlackEventBase {
  type: string;
  team?: string;
  event_ts?: string;
  [key: string]: unknown;
}

export interface AppMentionEvent extends SlackEventBase {
  type: "app_mention";
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel: string;
  bot_id?: string;
  bot_profile?: unknown;
}

export interface GenericMessageEvent extends SlackEventBase {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  channel_type?: string;
  bot_id?: string;
  bot_profile?: unknown;
}

export interface AssistantThreadStartedEvent extends SlackEventBase {
  type: "assistant_thread_started";
  assistant_thread: {
    channel_id: string;
    thread_ts: string;
  };
  channel?: string;
}

export type SlackEvent =
  | AppMentionEvent
  | GenericMessageEvent
  | AssistantThreadStartedEvent
  | SlackEventBase;

export function isAppMentionEvent(
  event: SlackEvent
): event is AppMentionEvent {
  return event.type === "app_mention" && typeof (event as AppMentionEvent).channel === "string";
}

export function isAssistantThreadStartedEvent(
  event: SlackEvent
): event is AssistantThreadStartedEvent {
  return event.type === "assistant_thread_started";
}

export function isGenericMessageEvent(
  event: SlackEvent
): event is GenericMessageEvent {
  return (
    event.type === "message" &&
    typeof (event as GenericMessageEvent).channel === "string"
  );
}

export interface MrkdwnElement {
  type: "mrkdwn";
  text: string;
}

export interface ContextBlock {
  type: "context";
  elements: MrkdwnElement[];
}

export interface SectionBlock {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
}

export type KnownBlock = SectionBlock | ContextBlock;
