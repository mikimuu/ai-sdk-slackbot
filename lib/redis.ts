import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { appConfig } from "./config";

const redis = new Redis({
  url: appConfig.redis.url,
  token: appConfig.redis.token,
});

const namespace = (suffix: string) => `${appConfig.redis.prefix}:${suffix}`;

export async function ensureIdempotency(
  key: string,
  ttlSeconds = 60 * 60 * 24
) {
  const namespacedKey = namespace(`idempotency:${key}`);
  const result = await redis.set(namespacedKey, "1", {
    nx: true,
    ex: ttlSeconds,
  });
  return result === "OK";
}

export async function clearIdempotency(key: string) {
  const namespacedKey = namespace(`idempotency:${key}`);
  await redis.del(namespacedKey);
}

type LockOptions = {
  ttlMs?: number;
  retryMs?: number;
  maxAttempts?: number;
};

type LockResult<T> = {
  ok: boolean;
  value?: T;
};

export async function withLock<T>(
  lockName: string,
  executor: () => Promise<T>,
  options: LockOptions = {}
): Promise<LockResult<T>> {
  const ttlMs = options.ttlMs ?? 30_000;
  const retryMs = options.retryMs ?? 200;
  const maxAttempts = options.maxAttempts ?? 20;
  const token = crypto.randomUUID();
  const lockKey = namespace(`lock:${lockName}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const acquired = await redis.set(lockKey, token, {
      nx: true,
      px: ttlMs,
    });

    if (acquired === "OK") {
      try {
        const value = await executor();
        return { ok: true, value };
      } finally {
        await releaseLock(lockKey, token);
      }
    }

    await sleep(retryMs * Math.pow(1.5, attempt));
  }

  return { ok: false };
}

async function releaseLock(lockKey: string, token: string) {
  const script = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end
  `;

  await redis.eval(script, [lockKey], [token]);
}

const sleep = (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const value = await redis.get<string>(namespace(`cache:${key}`));
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error(`Failed to parse cached value for ${key}`, error);
    return null;
  }
}

export async function cacheJson(
  key: string,
  value: unknown,
  ttlSeconds = 60 * 10
) {
  await redis.set(namespace(`cache:${key}`), JSON.stringify(value), {
    ex: ttlSeconds,
  });
}

export { redis };
