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
  ensureZapierToolExists,
  executeZapierTool,
  findZapierToolForIntent,
  listZapierTools,
} from "./zapier-mcp";
import { executionStore } from "./durable-store";
import { telemetryFor } from "./telemetry";

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
  tool?: "zapier";
  toolName?: string;
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

function ensureZapierBudget(intent: Intent) {
  const { toolBudget } = intent;
  if (toolBudget.maxZapCalls <= 0) {
    throw new BudgetExceededError(
      "Zapier MCP の利用上限を超えているため実行できません。"
    );
  }
}

async function validateIntentForZapier(intent: Intent) {
  const errors: string[] = [];
  const fields = intent.fields as Record<string, unknown>;
  const explicitToolName = String(
    fields.toolName ?? fields.zapierTool ?? ""
  ).trim();

  let resolvedToolName: string | undefined =
    explicitToolName.length > 0 ? explicitToolName : undefined;

  if (resolvedToolName) {
    const tool = await ensureZapierToolExists(resolvedToolName);
    if (!tool) {
      errors.push(`指定の Zapier ツール '${resolvedToolName}' が見つかりません`);
      resolvedToolName = undefined;
    }
  } else {
    const suggestion = await findZapierToolForIntent(intent);
    if (suggestion) {
      resolvedToolName = suggestion.toolName;
    } else {
      errors.push(
        "実行可能な Zapier ツールを特定できませんでした。操作内容を具体的に指示してください。"
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName: resolvedToolName,
  };
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
          "You are an intent extraction controller for a Slack HubSpot operations bot that executes all actions via Zapier MCP. " +
          "Only output JSON matching the provided schema. " +
          "Always populate fields.toolName (または zapierTool) with the Zap name to run. " +
          "Never fabricate HubSpot property names; rely on known fields or ask the user for clarification.",
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
      async () => validateIntentForZapier(intent)
    );

    const validation = validationStep.result;

    if (!validation.ok || !validation.toolName) {
      await executionStore.updateJobStatus(
        input.jobId,
        intent.confirmRequired ? "awaiting_confirmation" : "failed",
        validation.errors?.join(", ")
      );

      const issues = validation.errors ?? [];
      let prompt: string;
      if (issues.length > 0) {
        prompt = `以下の項目について追加情報が必要です:\n- ${issues.join("\n- ")}`;
      } else if (!validation.toolName) {
        const tools = await listZapierTools();
        const hubspotTools = tools.filter((tool) =>
          tool.toLowerCase().includes("hubspot")
        );
        const suggestions = hubspotTools.slice(0, 5).join("\n- ");
        prompt =
          suggestions.length > 0
            ? `HubSpot 用に利用可能な Zapier ツールの候補です:\n- ${suggestions}\nどれを使うか指示してください。`
            : "実行可能な Zapier ツールを特定できませんでした。ツール名や操作内容を詳しく教えてください。";
      } else {
        prompt = "入力が不足しています。";
      }

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

    const resolvedToolName = validation.toolName;
    const fieldsRecord = intent.fields as Record<string, unknown>;
    if (!fieldsRecord.toolName) {
      fieldsRecord.toolName = resolvedToolName;
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

    try {
      await runStep(
        "plan-execution",
        { intent },
        async () => {
          ensureZapierBudget(intent);
          return "zapier" as const;
        }
      );
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

    const executionChannel = "zapier" as const;

    const executionStep = await runStep(
      "execute",
      { intent, executionChannel, toolName: resolvedToolName },
      async () => {
        const {
          toolName: _toolName,
          zapierTool: _zapierTool,
          args,
          payload,
          ...rest
        } = fieldsRecord;

        const baseArgs =
          (args as Record<string, unknown> | undefined) ??
          (payload as Record<string, unknown> | undefined) ??
          {};

        const combinedArgs: Record<string, unknown> = {
          ...rest,
          ...baseArgs,
        };

        if (intent.filters.length > 0 && combinedArgs.filters === undefined) {
          combinedArgs.filters = intent.filters;
        }

        if (
          intent.action === "read" &&
          combinedArgs.limit === undefined &&
          intent.limit
        ) {
          combinedArgs.limit = intent.limit;
        }

        return executeZapierTool(resolvedToolName, combinedArgs);
      }
    );

    const executionResult = executionStep.result;

    await runStep("record-tool-call", executionResult, async () => {
      await executionStore.appendToolCall({
        id: crypto.randomUUID(),
        stepId: executionStep.stepId,
        toolName: resolvedToolName,
        payload: intent,
        response: executionResult,
        status: "succeeded",
      });
      return true;
    });

    const reviewStep = await runStep(
      "review",
      { intent, executionChannel, executionResult, toolName: resolvedToolName },
      async () => {
        const { text } = await generateText({
          model: openai(appConfig.ai.executorModel),
          system:
            "You are a Slack assistant summarizing Zapier automation results in Japanese. " +
            "Use short paragraphs or bullet points. Include concrete identifiers from the tool when available. " +
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
            {
              role: "user",
              content: `Tool Name: ${resolvedToolName}`,
            },
          ],
          maxTokens: 800,
          maxSteps: 4,
          experimental_telemetry: telemetryFor("review", {
            job_id: input.jobId,
            request_id: input.requestId,
            execution_channel: executionChannel,
            zapier_tool: resolvedToolName,
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
      toolName: resolvedToolName,
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
