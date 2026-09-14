export interface VerifyOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

export interface VerifyResult {
  healthy: boolean;
  status: number;
  latencyMs: number;
  url: string;
}

export async function verify(
  baseUrl: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const maxRetries = opts.maxRetries ?? 10;
  let delay = opts.initialDelayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10000;

  const normalizedUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const checkUrl = `${normalizedUrl}/api/v1/health`;

  let lastStatus = 0;
  let lastError = 'Unknown error';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(checkUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'edgepay-installer/1.0' },
      });
      clearTimeout(timer);

      lastStatus = res.status;
      const latencyMs = Date.now() - start;

      // Health endpoint returns 200, or install page returns 200
      if (res.status === 200) {
        return {
          healthy: true,
          status: res.status,
          latencyMs,
          url: checkUrl,
        };
      }

      // If /api/v1/health is unauthorized (401) or returns 404, check /install as fallback
      if (res.status === 401 || res.status === 404) {
        const installRes = await fetch(`${normalizedUrl}/install`, {
          signal: controller.signal,
        });
        if (installRes.status === 200) {
          return {
            healthy: true,
            status: installRes.status,
            latencyMs: Date.now() - start,
            url: `${normalizedUrl}/install`,
          };
        }
      }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 10000);
    }
  }

  throw new Error(`Health verification timed out after ${maxRetries} attempts for ${checkUrl} (last status: ${lastStatus}, error: ${lastError})`);
}
