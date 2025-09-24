import { sql } from "@vercel/postgres";
import { appConfig } from "./config";

export type JobStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed";

export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  slackEventId: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  lastError?: string | null;
}

export interface StepRecord {
  id: string;
  jobId: string;
  stepType: string;
  status: StepStatus;
  sequence: number;
  state: unknown;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
  error?: string | null;
}

export interface ToolCallRecord {
  id: string;
  stepId: string;
  toolName: string;
  payload: unknown;
  response: unknown;
  createdAt: Date;
  status: "succeeded" | "failed";
  error?: string | null;
}

class DurableExecutionStore {
  private schemaEnsured = false;

  private async ensureSchema() {
    if (this.schemaEnsured) return;

    await sql`
      create table if not exists jobs (
        id uuid primary key,
        slack_team_id text not null,
        slack_channel_id text not null,
        slack_thread_ts text not null,
        slack_event_id text not null,
        status text not null,
        last_error text,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
    `;

    await sql`
      create index if not exists jobs_event_idx
        on jobs (slack_team_id, slack_event_id);
    `;

    await sql`
      create table if not exists steps (
        id uuid primary key,
        job_id uuid references jobs(id) on delete cascade,
        step_type text not null,
        status text not null,
        sequence integer not null,
        state jsonb,
        result jsonb,
        error text,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
    `;

    await sql`
      create index if not exists steps_job_idx
        on steps (job_id, sequence);
    `;

    await sql`
      create table if not exists tool_calls (
        id uuid primary key,
        step_id uuid references steps(id) on delete cascade,
        tool_name text not null,
        payload jsonb,
        response jsonb,
        status text not null,
        error text,
        created_at timestamptz default now()
      );
    `;

    this.schemaEnsured = true;
  }

  async createJob(record: Omit<JobRecord, "createdAt" | "updatedAt">) {
    await this.ensureSchema();
    await sql`
      insert into jobs (id, slack_team_id, slack_channel_id, slack_thread_ts, slack_event_id, status, last_error)
      values (${record.id}, ${record.slackTeamId}, ${record.slackChannelId}, ${record.slackThreadTs}, ${record.slackEventId}, ${record.status}, ${record.lastError ?? null})
      on conflict (id) do update set status = excluded.status, last_error = excluded.last_error, updated_at = now();
    `;
  }

  async updateJobStatus(id: string, status: JobStatus, lastError?: string | null) {
    await this.ensureSchema();
    await sql`
      update jobs
      set status = ${status},
          last_error = ${lastError ?? null},
          updated_at = now()
      where id = ${id};
    `;
  }

  async appendStep(record: Omit<StepRecord, "createdAt" | "updatedAt">) {
    await this.ensureSchema();
    await sql`
      insert into steps (id, job_id, step_type, status, sequence, state, result, error)
      values (
        ${record.id},
        ${record.jobId},
        ${record.stepType},
        ${record.status},
        ${record.sequence},
        ${JSON.stringify(record.state ?? null)},
        ${JSON.stringify(record.result ?? null)},
        ${record.error ?? null}
      )
      on conflict (id) do update set
        status = excluded.status,
        sequence = excluded.sequence,
        state = excluded.state,
        result = excluded.result,
        error = excluded.error,
        updated_at = now();
    `;
  }

  async appendToolCall(record: Omit<ToolCallRecord, "createdAt">) {
    await this.ensureSchema();
    await sql`
      insert into tool_calls (id, step_id, tool_name, payload, response, status, error)
      values (
        ${record.id},
        ${record.stepId},
        ${record.toolName},
        ${JSON.stringify(record.payload ?? null)},
        ${JSON.stringify(record.response ?? null)},
        ${record.status},
        ${record.error ?? null}
      )
      on conflict (id) do update set
        response = excluded.response,
        status = excluded.status,
        error = excluded.error,
        created_at = excluded.created_at;
    `;
  }

  async latestStep(jobId: string) {
    await this.ensureSchema();
    const result = await sql<StepRecord[]>`
      select * from steps
      where job_id = ${jobId}
      order by sequence desc
      limit 1;
    `;

    return result.rows[0];
  }

  async loadJob(jobId: string) {
    await this.ensureSchema();
    const result = await sql<JobRecord[]>`
      select * from jobs where id = ${jobId};
    `;

    return result.rows[0];
  }
}

class InMemoryExecutionStore {
  private jobs = new Map<string, JobRecord>();
  private steps = new Map<string, StepRecord>();
  private toolCalls = new Map<string, ToolCallRecord>();

  async createJob(record: Omit<JobRecord, "createdAt" | "updatedAt">) {
    const now = new Date();
    this.jobs.set(record.id, {
      ...record,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateJobStatus(id: string, status: JobStatus, lastError?: string | null) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    job.lastError = lastError ?? null;
    job.updatedAt = new Date();
  }

  async appendStep(record: Omit<StepRecord, "createdAt" | "updatedAt">) {
    const now = new Date();
    const step: StepRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
    };
    this.steps.set(record.id, step);
  }

  async appendToolCall(record: Omit<ToolCallRecord, "createdAt">) {
    const now = new Date();
    const call: ToolCallRecord = {
      ...record,
      createdAt: now,
    };
    this.toolCalls.set(record.id, call);
  }

  async latestStep(jobId: string) {
    const steps = Array.from(this.steps.values()).filter(
      (step) => step.jobId === jobId
    );
    if (steps.length === 0) return undefined;
    return steps.sort((a, b) => b.sequence - a.sequence)[0];
  }

  async loadJob(jobId: string) {
    return this.jobs.get(jobId);
  }
}

let warnedPostgresDisabled = false;
const postgresEnabled = Boolean(appConfig.postgres.url);

if (!postgresEnabled && !warnedPostgresDisabled) {
  console.warn("Postgres が未設定のため、durable execution store をメモリで代替します。");
  warnedPostgresDisabled = true;
}

export const executionStore = postgresEnabled
  ? new DurableExecutionStore()
  : new InMemoryExecutionStore();
