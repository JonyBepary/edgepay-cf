/**
 * Gateway HTTP kit — fetch with timeout + normalized response handling.
 *
 * Every ported adapter funnels its outbound calls through gwFetch so that:
 *   - timeouts are enforced (PHP adapters set CURLOPT_TIMEOUT 10–15s; the
 *     ports preserve those numbers via AbortController — without it a hung
 *     provider pins the Worker invocation open until the 30s wall limit)
 *   - error text is truncated before it can leak into exceptions/logs
 *   - subrequest behaviour is uniform (fetch, never XHR shims)
 */

export interface GwRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Request timeout in ms. Default 15_000 (matches the PHP adapters' ceiling). */
  timeoutMs?: number;
}

export class GwTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Gateway request timed out after ${timeoutMs}ms: ${redact(url)}`);
    this.name = 'GwTimeoutError';
  }
}

/** Cap error/body text so a misbehaving provider can't flood logs. */
const MAX_TEXT = 512;

export function redact(url: string): string {
  // Keep host + path, drop query (query often carries keys/tokens).
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, MAX_TEXT);
  }
}

export function clipText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * fetch() with an AbortController deadline. Throws GwTimeoutError on timeout;
 * never throws for HTTP error statuses (caller decides — many providers use
 * 4xx bodies as structured errors).
 */
export async function gwFetch(req: GwRequest): Promise<Response> {
  const timeoutMs = req.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GwTimeoutError(req.url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON request helper returning a normalized envelope. `data` is null when
 * the body isn't valid JSON — mirrors the PHP `json_decode(..., true) ?? []`
 * guard pattern without throwing.
 */
export interface GwJsonResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
}

export async function gwJson<T = unknown>(req: GwRequest): Promise<GwJsonResponse<T>> {
  const res = await gwFetch(req);
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text: clipText(text) };
}

/** Build an application/x-www-form-urlencoded body (PHP http_build_query). */
export function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) params.append(k, v);
  }
  return params.toString();
}

/** Build a query string (PHP http_build_query for GET URLs). */
export function queryString(fields: Record<string, string>): string {
  return formBody(fields);
}
