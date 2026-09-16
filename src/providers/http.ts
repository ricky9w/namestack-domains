import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "../core/errors.js";

export type Fetch = typeof fetch;

export async function readJson(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  if (!response.body)
    throw new AppError("INVALID_RESPONSE", "The server returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new AppError("RESPONSE_TOO_LARGE", "The server response exceeded the size limit.");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("INVALID_RESPONSE", "The server did not return valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : undefined;
}

export async function requestJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
  retries = 2,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AppError("TIMEOUT", "Cloudflare request timed out.", 124, true)),
      10_000,
    );
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    let delay: number | undefined;
    try {
      const response = await fetcher(url, { ...init, signal: requestSignal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new AppError("UNEXPECTED_REDIRECT", "Cloudflare returned an unexpected redirect.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
        const wait = retryAfter(response.headers.get("retry-after"));
        const error =
          response.status === 401
            ? new AppError(
                "AUTH_REQUIRED",
                "Cloudflare rejected the credentials.",
                1,
                false,
                "Run auth login, or supply a valid CLOUDFLARE_API_TOKEN.",
              )
            : response.status === 403
              ? new AppError(
                  "FORBIDDEN",
                  "Cloudflare denied access to this operation.",
                  1,
                  false,
                  "Check the account and granted Registrar permissions.",
                )
              : new AppError(
                  response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR",
                  `Cloudflare returned HTTP ${response.status}.`,
                  1,
                  retryable,
                  undefined,
                  wait,
                );
        if (!retryable || attempt >= retries || (wait !== undefined && wait > 5)) throw error;
        delay = Math.max(wait ?? 0, 0.25 * 2 ** attempt);
      } else return await readJson(response);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        if (attempt >= retries) throw controller.signal.reason;
      } else if (!(error instanceof TypeError)) throw error;
      if (attempt >= retries)
        throw new AppError("NETWORK_ERROR", "Could not reach Cloudflare.", 1, true);
      delay = 0.25 * 2 ** attempt;
    } finally {
      clearTimeout(timer);
    }
    await sleep((delay ?? 0.25) * 1000, undefined, { signal });
  }
}
