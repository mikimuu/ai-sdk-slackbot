import crypto from "crypto";
import { openai } from "@ai-sdk/openai";
import { CoreMessage, generateObject, generateText } from "ai";
import { appConfig } from "./config";
import {
  Intent,
  IntentGuardrails,
  IntentSchema,
} from "./intent";
import {
  executeIntentWithHubSpot,
  validateIntentAgainstHubSpot,
} from "./hubspot";
import { executeZapierTool } from "./zapier-mcp";
import { executionStore } from "./durable-store";
import { telemetryFor } from "./telemetry";
import { withLock } from "./redis";

export type SlackWorkflowInput = {
  jobId: string;
  requestId: string;
  messages: CoreMessage[];
  latestUserMessage: string;
  slack: {
    teamId: string;
    channelId: string;
    threadTs: string;
    eventTs: string;
    eventId: string;
    userId: string;
  };
};

export type SlackWorkflowResult = {
  status: "completed" | "action_required" | "failed";
  text: string;
  intent?: Intent;
  tool?: "hubspot" | "zapier";
  rawResult?: unknown;
  issues?: string[];
};

type StepStatus = "running" | "succeeded" | "failed";

type StepRecordInput = {
  stepId: string;
  sequence: number;
  stepType: string;
  status: StepStatus;
  state?: unknown;
  result?: unknown;
  error?: string | null;
};

function formatSlackText(text: string) {
  return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
}

class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function determineExecutionChannel(intent: Intent): "hubspot" | "zapier" {
  const { toolBudget } = intent;

  const canUseHubSpot =
    intent.action === "read"
      ? intent.limit <= toolBudget.maxHsReads
      : toolBudget.maxHsWrites > 0;
  const canUseZapier = toolBudget.maxZapCalls > 0;

  if (intent.toolHint === "zapier") {
    if (!canUseZapier) {
      throw new BudgetExceededError(
        "Zapier MCP の利用上限を超えているため実行できません。"
      );
    }
    return "zapier";
  }

  if (intent.toolHint === "sdk") {
    if (!canUseHubSpot) {
      throw new BudgetExceededError(
        "HubSpot SDK の許容回数を超えているため実行できません。"
      );
    }
    return "hubspot";
  }

  if (intent.action === "report" || intent.limit > toolBudget.maxHsReads) {
    if (!canUseZapier) {
      throw new BudgetExceededError(
        "Zapier MCP の予算が不足しています。limit を下げるか、工具設定を変更してください。"
      );
    }
    return "zapier";
  }

  if (canUseHubSpot) return "hubspot";
  if (canUseZapier) return "zapier";

  throw new BudgetExceededError(
    "指定されたツール予算内で実行できません。制限を緩和するか、条件を調整してください。"
  );
}

export async function runSlackWorkflow(
  input: SlackWorkflowInput
): Promise<SlackWorkflowResult> {
  const sequenceCounter = { value: 0 };

  const recordStep = async (record: StepRecordInput) => {
    await executionStore.appendStep({
      id: record.stepId,
      jobId: input.jobId,
      stepType: record.stepType,
      status: record.status,
      sequence: record.sequence,
      state: record.state ?? null,
      result: record.result ?? null,
      error: record.error ?? null,
    });
  };

  const nextSequence = () => {
    sequenceCounter.value += 1;
    return sequenceCounter.value;
  };

  const runStep = async <T>(
    stepType: string,
    state: unknown,
    executor: () => Promise<T>
  ): Promise<{ result: T; stepId: string; sequence: number }> => {
    const stepId = crypto.randomUUID();
    const sequence = nextSequence();

    await recordStep({
      stepId,
      sequence,
      stepType,
      status: "running",
      state,
    });

    try {
      const result = await executor();
      await recordStep({
        stepId,
        sequence,
        stepType,
        status: "succeeded",
        state,
        result,
      });
      return { result, stepId, sequence };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      await recordStep({
        stepId,
        sequence,
        stepType,
        status: "failed",
        state,
        error: message,
      });
      throw error;
    }
  };

  try {
    const intentStep = await runStep("intent", { messages: input.messages }, async () => {
      const { object } = await generateObject<Intent>({
        model: openai(appConfig.ai.intentModel),
        schema: IntentSchema,
        maxTokens: 800,
        system:
          "You are an intent extraction controller for a Slack HubSpot operations bot. " +
          "Only output JSON matching the provided schema. " +
          "Prefer HubSpot SDK when actions are low latency or transactional. " +
          "Include fields.toolName when toolHint is 'zapier'. " +
          "Never fabricate HubSpot property names. Use the user's language to infer.",
        messages: input.messages,
        experimental_telemetry: telemetryFor("intent", {
          job_id: input.jobId,
          request_id: input.requestId,
          slack_channel: input.slack.channelId,
        }),
      });

      const intent = IntentGuardrails.enforceConfirmation(IntentSchema.parse(object));
      return intent;
    });

    const intent = intentStep.result;

    const validationStep = await runStep(
      "validate-intent",
      { intent },
      async () => validateIntentAgainstHubSpot(intent)
    );

    if (!validationStep.result.ok) {
      await executionStore.updateJobStatus(
        input.jobId,
        intent.confirmRequired ? "awaiting_confirmation" : "failed",
        validationStep.result.errors?.join(", ")
      );

      const issues = validationStep.result.errors ?? [];
      const prompt =
        issues.length > 0
          ? `以下の項目について追加情報が必要です:\n- ${issues.join("\n- ")}`
          : "入力が不足しています。";

      const { text } = await generateText({
        model: openai(appConfig.ai.executorModel),
        system:
          "You summarize validation errors for Slack users in Japanese. " +
          "Keep it concise, propose what information is required, avoid markdown lists beyond simple bullets.",
        messages: [
          {
            role: "user",
            content: `バリデーションエラー: ${prompt}`,
          },
        ],
        maxSteps: 2,
        experimental_telemetry: telemetryFor("validation-response", {
          job_id: input.jobId,
          request_id: input.requestId,
        }),
      });

      return {
        status: "action_required",
        text: formatSlackText(text),
        intent,
        issues,
      };
    }

    if (intent.confirmRequired) {
      await executionStore.updateJobStatus(
        input.jobId,
        "awaiting_confirmation",
        null
      );

      const { text } = await generateText({
        model: openai(appConfig.ai.executorModel),
        system:
          "You prepare confirmation prompts for Slack users in Japanese. " +
          "Be direct about required approval for large updates. Do not mention tokens or internal policy.",
        messages: [
          {
            role: "user",
            content: `Intent JSON: ${JSON.stringify(intent, null, 2)}`,
          },
        ],
        maxSteps: 2,
        experimental_telemetry: telemetryFor("hitl-prompt", {
          job_id: input.jobId,
          request_id: input.requestId,
        }),
      });

      return {
        status: "action_required",
        text: formatSlackText(text),
        intent,
      };
    }

    let executionChannel: "hubspot" | "zapier";

    try {
      const executionPlanStep = await runStep(
        "plan-execution",
        { intent },
        async () => determineExecutionChannel(intent)
      );
      executionChannel = executionPlanStep.result;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        const issues = [error.message];
        await executionStore.updateJobStatus(
          input.jobId,
          "failed",
          error.message
        );

        const { text } = await generateText({
          model: openai(appConfig.ai.executorModel),
          system:
            "You explain budget constraint issues for Slack users in Japanese. " +
            "Offer concrete next actions, keep it under three sentences.",
          messages: [
            {
              role: "user",
              content: error.message,
            },
          ],
          maxSteps: 2,
          experimental_telemetry: telemetryFor("budget-error", {
            job_id: input.jobId,
            request_id: input.requestId,
          }),
        });

        return {
          status: "action_required",
          text: formatSlackText(text),
          intent,
          issues,
        };
      }
      throw error;
    }

    const executionStep = await runStep(
      "execute",
      { intent, executionChannel },
      async () => {
        if (executionChannel === "hubspot") {
          const execute = () =>
            executeIntentWithHubSpot(intent, {
              requestId: input.requestId,
              traceId: input.jobId,
            });

          if (intent.action === "update" || intent.action === "delete") {
            const recordId = String(
              intent.fields.id ?? intent.fields.recordId ?? ""
            );

            if (!recordId) {
              throw new Error("更新・削除には id または recordId が必要です");
            }

            const lockKey = `hs:${intent.object}:${recordId}`;
            const lockResult = await withLock(lockKey, execute, {
              ttlMs: 30_000,
              retryMs: 400,
            });

            if (!lockResult.ok || lockResult.value === undefined) {
              throw new Error(
                "対象の HubSpot レコードがロック中のため処理できませんでした"
              );
            }

            return lockResult.value;
          }

          return execute();
        }

        const { toolName, zapierTool, args, payload, ...rest } =
          intent.fields as Record<string, unknown>;
        const resolvedToolName = String(toolName ?? zapierTool ?? "").trim();

        if (!resolvedToolName) {
          throw new Error(
            "Zapier の実行には fields.toolName (または zapierTool) が必要です"
          );
        }

        const toolArgs =
          (args as Record<string, unknown> | undefined) ??
          (payload as Record<string, unknown> | undefined) ??
          rest;

        return executeZapierTool(
          resolvedToolName,
          toolArgs as Record<string, unknown>
        );
      }
    );

    const executionResult = executionStep.result;

    await runStep("record-tool-call", executionResult, async () => {
      await executionStore.appendToolCall({
        id: crypto.randomUUID(),
        stepId: executionStep.stepId,
        toolName:
          executionChannel === "hubspot" ? "hubspot-sdk" : "zapier-mcp",
        payload: intent,
        response: executionResult,
        status: "succeeded",
      });
      return true;
    });

    const reviewStep = await runStep(
      "review",
      { intent, executionChannel, executionResult },
      async () => {
      const { text } = await generateText({
        model: openai(appConfig.ai.executorModel),
        system:
          "You are a Slack assistant summarizing HubSpot or Zapier actions in Japanese. " +
          "Use short paragraphs or bullet points. Include concrete HubSpot IDs when available. " +
          "Do not mention internal policies.",
        messages: [
          {
            role: "user",
            content: `Intent: ${JSON.stringify(intent, null, 2)}`,
          },
          {
            role: "user",
            content: `Result: ${JSON.stringify(executionResult).slice(0, 3500)}`,
          },
        ],
        maxTokens: 800,
        maxSteps: 4,
        experimental_telemetry: telemetryFor("review", {
          job_id: input.jobId,
          request_id: input.requestId,
          execution_channel: executionChannel,
        }),
      });

        return formatSlackText(text);
      }
    );

    await executionStore.updateJobStatus(input.jobId, "completed", null);

    return {
      status: "completed",
      text: reviewStep.result,
      intent,
      tool: executionChannel,
      rawResult: executionResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await executionStore.updateJobStatus(input.jobId, "failed", message);

    return {
      status: "failed",
      text: "エラーが発生しました。再実行するか管理者に確認してください。",
      issues: [message],
    };
  }
}
