# Slack HubSpot Agent Architecture
i# Slack HubSpot Agent Architecture

## 1. ミッションと守備範囲
- Slackの`app_mention`を起点にHubSpotの更新・照会を即応する社内向けAIオペレーションボット。
- ユーザーは自然言語で指示し、エージェントがZapier MCPまたはHubSpot SDKを選択して実務を自動化。
- 3秒以内ACK、失敗時の透明なリカバリー、Zapier課金管理を前提に運用する。

## 2. コンポーネント全体像
- **Slack Ingress**: Events API受信、署名検証、3秒ACK。NodeランタイムのApp Router Route Handlerで実装。
- **Execution Queue**: `request.waitUntil` → Vercel Background Function（将来は専用キューサービス）で非同期実行。
- **Agent Orchestrator**: Vercel AI SDK Core＋OpenAIプロバイダー。意図解析・ツール選択・マルチステップ制御を担当。
- **Tool Layer**: Zapier MCP（ノーコード業務）、HubSpot SDK（高頻度/大容量）。Slack出力ラッパーも含む。
- **Context Store**: 会話履歴・ツール結果・Zap/HubSpot識別子を保存。短期はジョブコンテキスト、長期はナレッジベースに反映。
- **Observability Hub**: 構造化ログ、トレース、アラート。Zapierタスク使用量とHubSpot APIクォータを集計。

## 3. データフロー（@メンション）
1. Slack → `POST /api/slack/events`。署名検証後、ACKレスポンスと同時にバックグラウンドキック。
2. バックグラウンドジョブが会話状態を取得、メッセージからボット宛メンションを除去。
3. AIエージェントが意図を`generateObject`で抽出し、ZapierかHubSpotか、もしくは説明回答のみかを決定。
4. 必要ツールを連鎖実行（最大Nステップ）。途中進捗はSlackのステータス更新メソッドで通知。
5. 実行結果／失敗理由をスレッド返信し、履歴ストアと観測基盤へ記録。

## 4. エージェント設計
### 4.1 モデル戦略
- Vercel AI SDK経由でChatGPT（`openai('gpt-5')`想定）を利用。
- `generateText`で最終レスポンス、`generateObject`で構造化意図を生成。
- `providerOptions.openai.reasoning.effort`と`max_completion_tokens`をタスク難度で切り替え、推論コストを管理。

### 4.2 マルチエージェント構成
- **Orchestrator**: 全体プロンプト、ポリシー、ハルシネーション抑制（ツール未実行時は回答禁止）。
- **Intent Specialist**: `generateObject`専任。ZodスキーマでCRUD/検索/レポートなどに分類し、エラー時は再試行。
- **Execution Specialist**: ツール呼び出しと結果検証を担当。Zapierタスク失敗時のリトライポリシーやHubSpot SDKのページネーションを実装。
- 各エージェントはVercel AI SDKの`tool` APIで相互呼び出し可能なサブエージェントとして登録し、オーケストレーターが必要時に委譲する。

### 4.3 コンテキスト自動学習
- 短期記憶: ジョブごとの`SharedState`にメッセージ履歴、直近ツール結果、エスカレーション条件を保存。
- 長期記憶: RAGストア（例: Supabase/Postgres＋pgvector）にタスク成功例・失敗例を日次でアップサートし、次回プロンプト生成時に類似事例を自動ロード。
- 自動学習ルール: 成功時は要約＋ツール引数を学習セットに追加、失敗時は“禁止パターン”としてタグ付け。オーケストレーターは類似事例から前置文を構築。

## 5. ツールレイヤー
### 5.1 Zapier MCP
- `experimental_createMCPClient`で接続し、Zapier提供の工具をAIツールとして統合。
- 1コール=Zapierタスク2消費を前提に、AI側で「実行前確認」ポリシーを設置（大量更新時はユーザー確認フロー）。
- Zap ID、入力ペイロード、タスクIDをログに残し、再試行時の重複実行を避ける。

### 5.2 HubSpot SDK
- `@hubspot/api-client`で大量検索や低レイテンシ更新をハンドリング。
- OAuthスコープは最小限（contacts/companies/deals read/write＋必要機能のみ）。
- レート制限に達した際はZapier fallbackまたはユーザーへのリトライ案内を返す。

### 5.3 Slack返答ユーティリティ
- `chat.postMessage`、`chat.update`、`assistant.threads.setStatus`を共通化。
- 返信テンプレートは意図別（成功・確認待ち・失敗）に整理し、オーケストレーターが文面生成に専念できるようにする。

## 6. Vercel AI SDK活用ポイント
- `generateText`/`generateObject`: 応答生成と構造化意図抽出。
- `streamText`: Slackの進捗更新で部分的な思考を出す場合に利用。
- `tool` API: Zapier MCPやHubSpot SDKを統合し、マルチステップ推論時に自動選択。
- `experimental_createMCPClient`: Zapier MCP接続。
- `waitUntil`ユーティリティ（Edge互換）ではなくNodeランタイムの`AsyncLocalStorage`と組み合わせ、トレースIDを渡す。
- 将来: `ai-sdk-agents`の導入を検討し、エージェント間委譲をテンプレ化。

## 7. コンテキストマネジメント設計
- **短期**: Slackスレッド単位でRedis/Upstash等にJSON保存。キーは`thread_ts`。TTL 24h、完了時に観測基盤へ移送。
- **長期**: Postgresに`tasks`テーブル（intent, tools, outcome, tokens, cost）。ベクトル列でユーザー指示と結果を格納し、次回類似指示で検索。
- **自動学習**: バッチジョブが成功例をテンプレ化、失敗例をガードレールPromptsに追記。再トレーニング不要で「覚える」運用を実現。

## 8. オペレーションとセキュリティ
- SecretsはVercel Envに格納し、Zapier・HubSpot・Slackそれぞれをローテーション。監査ログにアクセス履歴を残す。
- Zapierタスク消費量、HubSpot API使用量、OpenAIコストを日次でダッシュボード化。
- 異常時（例: 429, Zapier失敗）は即座にSlackへ“人間アシスト必要”タグ付きで返信し、オンコールへPagerDuty通知。
- コンプライアンス: HubSpotレコードIDやメールアドレスはログ時にマスキングし、保存先を限定。

## 9. 実装ロードマップ
1. Slack入口（署名検証＋`waitUntil`）を完成させ、テスト用リクエストでACKタイミングを検証。
2. エージェントプロンプト＋Zodスキーマを定義し、Zapier/HupSpotツールを`tool` APIに登録。
3. コンテキストストア（短期Redis＋長期Postgres）を立ち上げ、履歴の自動取り込みバッチを組む。
4. 観測ダッシュボード（コスト/成功率/タスク消費）とエラーハンドリング通知を構築。
5. マルチエージェントPoC（Intent Specialist⇄Execution Specialist）を実装し、効果測定後に本番適用。

## 10. 会話ログ抜粋（2025-09-23）
- Slackbotアーキテクチャ方針決定、Zapier MCP＋HubSpot SDKハイブリッド採用。
- モデル戦略をChatGPT（OpenAI API）主体に変更し、`reasoning.effort`制御を導入。
- マルチエージェント＆コンテキスト自動学習リサーチ（Task Memory Engine / RCR-Router / MemTool など）を参考資料として採用。
- 本ドキュメントを全面改訂し、最新アーキテクチャを反映。
---

## 1. ミッションと守備範囲
- Slack の `app_mention` を起点に HubSpot を検索・更新できる社内向け AI オペレーションボット。
- Vercel（Node ランタイム）＋ Vercel AI SDK を前提に、AI ワークフローの可観測性・再実行性・コスト制御を最優先で設計する。
- Zapier MCP と HubSpot SDK をハイブリッドに用い、Slack ユーザーの自然言語指示を安全かつ監査可能な業務フローへ変換する。

## 2. Vercel ネイティブ基盤
- **Slack Ingress**: App Router の Route Handler（Node ランタイム）で Events API を受け、生ボディ＋ HMAC-SHA256 で署名検証し 3 秒以内に ACK。
- **Fluid Compute / Background Functions**: ACK 後は `request.waitUntil` または Background Function にオフロードして長時間タスクを実行。
- **AI SDK Core**: `generateText` / `streamText` / `generateObject` で OpenAI モデル（例: `openai('gpt-5')`）を統一的に呼び出す。
- **AI SDK 5 ループ制御**: `maxSteps`, `stopWhen`, `prepareStep` を使い、ツール実行ループを制御する。各ステップ毎にコンテキストを保存し、異常時は最新ステップから再開できるようにする。
- **MCP クライアント**: `experimental_createMCPClient` で Zapier MCP を接続し、MCP 経由でツール定義を差し替え可能にする。
- **AI Gateway (任意)**: 予算管理やモデルフォールバックが必要な場合は Gateway 経由で呼び出してモニタリングを強化。

## 3. グラフ型オーケストレーション
- **Supervisor ノード**: LLM プロンプト・方針・ポリシーを集約し、各ステップの `prepareStep` でモデルパラメータ（`reasoning.effort`, `max_completion_tokens`）とツール予算を設定。
- **Intent ノード**: `generateObject`＋ OpenAI Function Calling 互換の Zod スキーマで意図を構造化。未充足フィールドがあれば即停止し、Slack に追加入力を要求。
- **Execution ノード**: MCP ツールまたは HubSpot SDK を呼び出し、結果・失敗をステップ履歴に格納。429/失敗時は指数バックオフ→フォールバック先を選択。
- **Review / Final ノード**: 最終レスポンス生成、監査用メタデータ組み立て、Slack 返信。
- **チェックポイント**: 各ステップ終了後に Durable Execution Store（Postgres など）へ conversation state・tool results・`stepId` を永続化。クラッシュ時は最新チェックポイントから再開。
- **HITL（人間介入）**: Intent が `confirmRequired=true`（例: 50 件以上更新）なら Supervisor が Slack モーダルを起動し、承認結果を受けて実行を再開。

## 4. Exactly-Once & 排他制御
- **Idempotency**: `idempotencyKey = ${team_id}:${event_id}:${event_ts}` を Redis `SETNX`＋TTL 24h で確保。`X-Slack-Retry-*` の再送はキー衝突により無視。
- **スレッドロック**: 同一 `thread_ts` ごとに Redis ロックを取得し、順序性と単一実行を保証。
- **リソースロック**: HubSpot レコード操作時は `hs:<object>:<recordId>` ロックを用意し、競合書き込みを直列化。
- **解放タイミング**: 成功・失敗いずれも最新チェックポイントで確定後に idempotency キーとロックを解放。

## 5. Intent スキーマとガードレール
```ts
const IntentSchema = z.object({
  action: z.enum(['read','create','update','upsert','delete','report']),
  object: z.enum(['contact','company','deal','ticket','custom']),
  filters: z.array(z.object({
    field: z.string(),
    op: z.enum(['eq','contains','in','gt','lt']),
    value: z.union([z.string(), z.number(), z.array(z.string())])
  })).default([]),
  fields: z.record(z.any()).default({}),
  limit: z.number().int().positive().max(500).default(50),
  confirmRequired: z.boolean().default(false),
  toolHint: z.enum(['zapier','sdk','auto']).default('auto'),
  toolBudget: z.object({
    maxZapCalls: z.number().int().min(0).default(2),
    maxHsReads: z.number().int().min(1).default(100),
    maxHsWrites: z.number().int().min(0).default(50)
  }).default({})
});
```
- LLM から自由テキストで戻る経路は禁止。Intent がバリデーションに失敗した場合は再質問する。
- HubSpot プロパティ定義をキャッシュし、送信前に型・必須チェックを行う。違反時は実行前にエラー返却。
- ツール実行結果が無い状態で確定文を生成することをポリシーで禁止。

## 6. ツール選択ポリシー
- **Zapier MCP**: 低頻度・ノーコードオペ・一括業務の自動化に使用。1 ツールコール = Zapier タスク 2 消費を前提に、`toolBudget.maxZapCalls` を監視。429/5xx 時は指数バックオフ→HubSpot SDK へフォールバック。
- **HubSpot SDK**: 高頻度読み取り・低レイテンシ更新・大量バッチに使用。レート制限時は Zapier MCP へ切替。
- **Slack I/O**: `chat.postMessage` / `chat.update` / `assistant.threads.setStatus` を共通ラッパー化し、進捗（受付→解析→実行→検証→完了）を逐次通知。失敗時は再実行ボタン＆ Runbook リンクを添付。

## 7. Durable Execution Store
- PostgreSQL で `jobs`, `steps`, `tool_calls` テーブルを管理。各ステップに conversation state, tool payload, Slack traceId を格納。
- 失敗時は最新ステップ状態から再開し、リトライ回数・最後のエラーを保存。
- 長時間バッチは分割（例: 200 件更新→ 50 件×4 ステップ）し、最後に集約メッセージを送る。

## 8. コンテキストと自動学習
- **短期メモリ**: Redis に `thread_ts` 単位で最新メッセージ・ステータス・ツール出力を保存（TTL 24h）。
- **長期メモリ / RAG**: Postgres＋pgvector に成功レシピ・禁止パターンを embeddings で格納。`toolHint='auto'` の際に類似ケースを検索し、前置プロンプトへ挿入。
- **メモリルータ**: Intent 種別と担当エージェントに応じて取得するコンテキスト断片を制御（例: `action='update'` → 最新成功例＋禁止パターンのみ）。
- **自動学習**: 成功ステップはテンプレ化して長期メモリに追加、失敗はガードレールに追記。手動ラベル無しでも段階的に精度を上げる。

## 9. 可観測性・コスト・SLO
- AI SDK の `experimental_telemetry` でトレースを収集し、Vercel Observability や Datadog/Axiom へ送信。
- トレース ID を `slack_event_id → job_id → step_id → tool_run_id (zap_run_id / hs_request_id)` のチェーンで連結。
- SLO 例: ACK < 3s, P95 完了 < 20s, エラー率 < 1%。エラーバジェット超過時は Zapier のみ運用などセーフモードへ自動移行。
- コストダッシュボード: Zapier タスク消費, HubSpot API 使用量, LLM トークン, AI Gateway 予算を日次集計し、閾値超過時に通知。

## 10. セキュリティと監査
- Secrets は Vercel Env（環境ごとに分離）に格納し、Bot 専用サービスアカウントのみ使用。
- HubSpot 書き込みは `origin=slack-bot`, `actor_slack_id`, `actor_email` をカスタムプロパティに残し、Zapier 側も同等の監査フィールドを記録。
- PII は短期メモリでマスキングし、長期ストアでは暗号化列を利用。監査ログは 1 年保持。
- PR 時はダミー資格情報で Contract Test を実行し、実シークレットを使わない。

## 11. 実装ロードマップ
1. Redis に idempotency + スレッドロック + HubSpot レコードロックを実装し、ACK < 3s と再送抑止を確認。
2. Intent Schema／関数シグネチャ／HubSpot プロパティ検証を統合し、未充足フィールドで実行を止める。
3. Vercel AI SDK の `maxSteps`＋`stopWhen`＋`prepareStep` を使ったグラフ型ループとチェックポイント保存、HITL モーダル再開を実装。
4. 観測ダッシュボード（SLO・コスト）と `experimental_telemetry` トレース連結を整備。
5. `/hs dry-run` コマンドと差分プレビューモーダルを追加し、Zapier↔SDK フォールバックと分割バッチを自動テスト。

## 12. WBS & タスク分解
- [WBS 1.0] プロジェクトセットアップ（Sprint 0, 1週） — Owner: PM
  - [1.1] キックオフ＆役割合意（PM, TL, PO） — Dep: なし
  - [1.2] 開発環境テンプレート整備（Eng-A, Eng-C） — Dep: 1.1
  - [1.3] オンボーディング資料作成（PM, Eng-B） — Dep: 1.1
  - [1.4] 学習ログ仕組み構築（Notion, Slack チャンネル） — Owner: PM, Dep: 1.1

- [WBS 2.0] Slack Ingress & 再送制御（Sprint 1, 2週） — Owner: Eng-A
  - [2.1] `app/api/slack/events` Route Handler スタブ実装 — Dep: 1.2
  - [2.2] 署名検証ユニットテスト追加 — Dep: 2.1
  - [2.3] Redis `SETNX` idempotency 実装 — Dep: 2.1
  - [2.4] スレッドロック＋HubSpot レコードロック実装 — Dep: 2.3
  - [2.5] 3 秒 ACK 負荷テスト（k6） — Dep: 2.2, 2.4

- [WBS 3.0] Intent 解析 & ツール契約（Sprint 1, 2週） — Owner: Eng-B
  - [3.1] Intent Schema（Zod＋Function Calling）実装 — Dep: 1.3
  - [3.2] HubSpot プロパティメタキャッシュ機構 — Dep: 3.1
  - [3.3] Intent バリデーション失敗時の再質問 UX — Dep: 3.1
  - [3.4] ツール予算計算ロジック（`toolBudget`） — Dep: 3.1

- [WBS 4.0] Vercel AI SDK グラフ制御（Sprint 2, 2週） — Owner: Eng-B, TL
  - [4.1] `maxSteps`＋`stopWhen`＋`prepareStep` を用いた Supervisor 実装 — Dep: 2.x, 3.x
  - [4.2] Durable チェックポイント（Postgres `jobs/steps`） — Dep: 4.1
  - [4.3] >50 件更新時の HITL モーダル停止／再開 — Dep: 4.1, 3.4
  - [4.4] 失敗時リトライ→フォールバック制御 — Dep: 4.2

- [WBS 5.0] ツールレイヤー統合（Sprint 2, 2週） — Owner: Eng-C
  - [5.1] Zapier MCP クライアント接続（`experimental_createMCPClient`） — Dep: 4.1
  - [5.2] HubSpot SDK 直接呼び出しラッパ — Dep: 5.1
  - [5.3] ツール選択ポリシー＆フォールバック実装 — Dep: 5.1, 5.2, 3.4
  - [5.4] Slack 出力ラッパ＋ステータス更新 — Dep: 5.2

- [WBS 6.0] 観測・SLO・コスト（Sprint 3, 2週） — Owner: Eng-D
  - [6.1] `experimental_telemetry` 連携＆traceId チェーン — Dep: 4.2, 5.x
  - [6.2] SLO メトリクス（ACK/P95/Error）収集 — Dep: 6.1
  - [6.3] コストダッシュボード（Zapier, HubSpot, LLM） — Dep: 6.1
  - [6.4] エラーバジェット監視＋セーフモードルール — Dep: 6.2, 6.3

- [WBS 7.0] UX & Runbook（Sprint 3, 2週） — Owner: Eng-A, Eng-D
  - [7.1] `/hs dry-run` コマンド実装 — Dep: 5.x
  - [7.2] 差分プレビューモーダル（Slack Block Kit） — Dep: 7.1, 3.2
  - [7.3] 失敗時再実行ボタン＋Runbook 添付 — Dep: 5.4, 6.2
  - [7.4] 運用 Runbook・オンコール手順書 — Dep: 7.3

- [WBS 8.0] ハードニング & リリース準備（Hardening Week, 1週） — Owner: TL, PM
  - [8.1] 負荷・フォールト注入テスト（Redis/HubSpot/Zapier遮断） — Dep: 2-7
  - [8.2] 監査項目チェック（権限・ログ・PIIマスキング） — Dep: 10.x
  - [8.3] プレイバックデモ＆Go/No-Go 会議 — Dep: 8.1, 8.2
  - [8.4] 本番ローンチ手順書の確定 — Dep: 8.3

## 13. 会話ログ抜粋（2025-09-23）
- Slackbot アーキテクチャ方針を Vercel AI SDK ＋ MCP ハイブリッドで確定。
- モデル戦略を ChatGPT（OpenAI API）主体とし、`reasoning.effort` をタスク難度で制御。
- マルチエージェント／コンテキスト自動学習／グラフ型耐久実行の要件を追加。
- 本ドキュメントを Vercel ネイティブのベストプラクティスに沿って全面更新。
