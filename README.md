# AI SDK Slackbot
 I’ll suggest clear, concise next actions like setting up the Zapier environment with API keys, verifying the SSE connection, updating fallback or
  budget logic, running integration and performance tests, and validating connector functionality locally to help the user move forward effectively.

> - Zapier 側で MCP エンドポイントと API キーを確認し、ZAPIER_MCP_URL / ZAPIER_MCP_API_KEY を Vercel 環境変数に投入して本番・ステージングに反映させま
  しょう。
  - ローカルかステージングで listZapierTools() を一度叩き、登録された Zapier ツール名が取得できるかを確認。そのまま executeZapierTool が成功するか簡単な
  Zap を作って疎通テストを。
  - Slack から「Zapier で○○を実行して」と指示するシナリオを試し、Intent 解析→Zapier 実行→サマリー返信の流れが通るか SLO（ACK <3s など）もチェック。
  - 予算超過ハンドリングを検証するために toolBudget.maxZapCalls / maxHsReads を意図的に小さく設定し、制限に引っかかった場合のエラーメッセージが想定どお
  りか確認。
  - その結果を踏まえて Zapier 側の Runbook と運用ルール（失敗時の再実行・フォールバック条件）を整理し、README か社内ドキュメントに追記すると安心です。
  - 
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnicoalbanese%2Fai-sdk-slackbot&env=SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET,OPENAI_API_KEY&envDescription=API%20keys%20needed%20for%20application&envLink=https%3A%2F%2Fgithub.com%2Fnicoalbanese%2Fai-sdk-slackbot%3Ftab%3Dreadme-ov-file%234-set-environment-variables&project-name=ai-sdk-slackbot)

An AI-powered chatbot for Slack powered by the [AI SDK by Vercel](https://sdk.vercel.ai/docs).

## Features

- Integrates with [Slack's API](https://api.slack.com) for reliable event ingestion and response streaming
- Uses [Vercel AI SDK](https://sdk.vercel.ai) multi-step control to extract intents, execute tools, and summarize outcomes
- Executes HubSpot CRM reads and writes via the official SDK with schema validation and locking
- Falls back to Zapier MCP tools for bulk/no-code automations with budget tracking
- Persists durable execution checkpoints to Postgres and uses Redis for idempotency + locking
- Streams progress via Slack reactions, assistant status updates, and audit-friendly thread context blocks

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed
- Slack workspace with admin privileges
- [OpenAI API key](https://platform.openai.com/api-keys)
- HubSpot private app token with CRM scope
- Zapier MCP endpoint + API key for fallback automations
- HTTP-accessible Redis (e.g. [Upstash](https://upstash.com)) for locks & caching
- Postgres instance for durable execution state (e.g. [Vercel Postgres](https://vercel.com/postgres))
- A server or hosting platform (e.g., [Vercel](https://vercel.com)) to deploy the bot

## Setup

### 1. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 2. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From scratch" and give your app a name
3. Select your workspace

### 3. Configure Slack App Settings

- Go to "Basic Information"
   - Under "App Credentials", note down your "Signing Secret". This will be an environment variable `SLACK_SIGNING_SECRET`
- Go to "App Home"
  - Under Show Tabs -> Messages Tab, Enable "Allow users to send Slash commands and messages from the messages tab"
- Go to "OAuth & Permissions"
   - Add the following [Bot Token Scopes](https://api.slack.com/scopes):
      - `app_mentions:read`
      - `assistant:write`
      - `chat:write`
      - `reactions:write`
      - `im:history`
      - `im:read`
      - `im:write`
   - Install the app to your workspace and note down the "Bot User OAuth Token" for the environment variable `SLACK_BOT_TOKEN`

- Go to "Event Subscriptions"
   - Enable Events
   - Set the Request URL to either
      - your deployment URL: (e.g. `https://your-app.vercel.app/api/events`)
      - or, for local development, use the tunnel URL from the [Local Development](./README.md#local-development) section below
   - Under "Subscribe to bot events", add:
      - `app_mention`
      - `assistant_thread_started`
      - `message:im`
   - Save Changes

> Remember to include `/api/events` in the Request URL.

You may need to refresh Slack with CMD+R or CTRL+R to pick up certain changes, such as enabling the chat tab

### 4. Set Environment Variables

Create a `.env` file in the root of your project with the following:

```
# Slack Credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_ID=your-slack-app-id

# OpenAI Credentials
OPENAI_API_KEY=your-openai-api-key

# HubSpot SDK
HUBSPOT_PRIVATE_APP_TOKEN=pat-xxx

# Redis (idempotency, locks, cache)
REDIS_REST_URL=https://<your-upstash-url>
REDIS_REST_TOKEN=your-upstash-token
REDIS_PREFIX=slack-hubspot-agent

# Durable Execution Store
POSTGRES_URL=postgres://user:password@host:5432/dbname

# Zapier MCP Gateway
ZAPIER_MCP_URL=https://mcp.zapier.com/sse
ZAPIER_MCP_API_KEY=your-zapier-mcp-api-key

# Optional overrides
AI_SUPERVISOR_MODEL=openai:gpt-5-reasoning-preview
AI_INTENT_MODEL=openai:gpt-4o-mini
AI_EXECUTOR_MODEL=openai:gpt-4o
AI_TELEMETRY_ENABLED=true
SLACK_REACTION_IN_PROGRESS=hourglass_flowing_sand
SLACK_REACTION_DONE=check_mark_button
```

Replace the placeholder values with your actual tokens.

## Local Development

Use the [Vercel CLI](https://vercel.com/docs/cli) and [untun](https://github.com/unjs/untun) to test out this project locally:

```sh
pnpm i -g vercel
pnpm vercel dev --listen 3000 --yes
```

```sh
npx untun@latest tunnel http://localhost:3000
```

Make sure to modify the [subscription URL](./README.md/#enable-slack-events) to the `untun` URL.

> Note: you may encounter issues locally with `waitUntil`. This is being investigated.

## Production Deployment

### Deploying to Vercel

1. Push your code to a GitHub repository

2. Deploy to [Vercel](https://vercel.com):

   - Go to vercel.com
   - Create New Project
   - Import your GitHub repository

3. Add your environment variables in the Vercel project settings:

   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `OPENAI_API_KEY`

4. After deployment, Vercel will provide you with a production URL

5. Update your Slack App configuration:
   - Go to your [Slack App settings](https://api.slack.com/apps)
   - Select your app

   - Go to "Event Subscriptions"
      - Enable Events
      - Set the Request URL to: `https://your-app.vercel.app/api/events`
   - Save Changes

## Usage

The bot will respond to:

1. Direct messages - Send a DM to your bot
2. Mentions - Mention your bot in a channel using `@YourBotName`

The bot maintains context within both threads and direct messages, so it can follow along with the conversation.

### Customising the Assistant

The chatbot prompts the model to behave like a staffing and talent-introduction assistant. Tailor its tone or supported workflows by editing the system prompt in `lib/generate-response.ts` or by adjusting the helper messages in `lib/handle-messages.ts`.

To integrate with internal systems (ATS, CRM, knowledge bases, etc.), extend the Slack handlers to call those services before or after generating the model response.

If your workspace uses different emoji for progress tracking, adjust `SLACK_REACTION_IN_PROGRESS` and `SLACK_REACTION_DONE` (or change the defaults in `lib/slack-utils.ts`).

## License

MIT
