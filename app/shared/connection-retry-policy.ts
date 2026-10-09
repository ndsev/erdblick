import {z} from "zod";

export const MAX_RETRY_DELAY_MS = 0x7fffffff;
export const retryDelaySchema = z.coerce.number().finite().int().min(1).max(MAX_RETRY_DELAY_MS);
export const retryMultiplierSchema = z.coerce.number().finite().min(1);

/** One browser's retry policy; producer hints remain a lower bound. */
export interface ConnectionRetryPolicy {
    enabled: boolean;
    initialDelayMs: number;
    backoffMultiplier: number;
    maxDelayMs: number;
}

export const DEFAULT_CONNECTION_RETRY_POLICY: Readonly<ConnectionRetryPolicy> = {
    enabled: true, initialDelayMs: 5000, backoffMultiplier: 2, maxDelayMs: 60000
};

export const connectionRetryPolicySchema = z.object({
    enabled: z.boolean(),
    initialDelayMs: retryDelaySchema,
    backoffMultiplier: retryMultiplierSchema,
    maxDelayMs: retryDelaySchema
}).refine(value => value.maxDelayMs >= value.initialDelayMs, {
    message: "Maximum delay must be at least the initial delay."
});

/** Failure state belongs to the existing request owner, including during its next attempt. */
export interface ConnectionRetryAttempt {
    attempt: number;
    failedAt: number;
    minimumDelayMs: number;
    at: number;
    message: string;
}

/** Caps before overflow can reach a browser timer; Infinity means automatic retry is disabled. */
export function connectionRetryDeadline(policy: ConnectionRetryPolicy, retry: ConnectionRetryAttempt): number {
    if (!policy.enabled) return Infinity;
    const backoff = Math.min(policy.maxDelayMs,
        policy.initialDelayMs * Math.pow(policy.backoffMultiplier, retry.attempt));
    return retry.failedAt + Math.max(retry.minimumDelayMs, Math.ceil(backoff));
}

/** Records one failure per attempt; repeated status frames during the wait do not advance backoff. */
export function recordConnectionFailure(previous: ConnectionRetryAttempt | undefined,
                                        message: string, minimumDelayMs = 0): ConnectionRetryAttempt {
    if (previous && previous.at > 0) return previous;
    return {attempt: previous ? Math.min(previous.attempt + 1, Number.MAX_SAFE_INTEGER) : 0, failedAt: Date.now(),
        minimumDelayMs, at: 0, message};
}
