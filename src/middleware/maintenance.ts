/**
 * Maintenance mode middleware — port of EdgePay's PHP MaintenanceMiddleware.
 *
 * EdgePay signals maintenance via a `storage/.maintenance` file containing
 * JSON `{reason, retry_after}`. In Workers we have no filesystem — the
 * maintenance flag lives in KV under key `system:maintenance`.
 *
 * Bypass paths:
 *   - /install/*
 *   - /api/v1/health
 *   - /admin/maintenance/* (so admins can disable it)
 *   - /assets/*
 *   - /favicon.ico
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';

interface MaintenanceInfo {
  reason: string;
  retry_after: number;
  started_at: string;
}

const BYPASS_PREFIXES = ['/install', '/api/v1/health', '/admin/maintenance'];
const BYPASS_EXACT = ['/favicon.ico'];

export const maintenanceMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = c.req.path;

  // Allow bypass paths
  if (BYPASS_PREFIXES.some(p => path.startsWith(p)) || BYPASS_EXACT.includes(path)) {
    return await next();
  }

  // Check maintenance flag in KV
  const flag = await c.env.KV.get('system:maintenance');
  if (!flag) {
    return await next();
  }

  let info: MaintenanceInfo;
  try {
    info = JSON.parse(flag);
  } catch {
    info = { reason: 'Maintenance in progress', retry_after: 300, started_at: new Date().toISOString() };
  }

  // JSON responses for API routes
  const isApi = path.startsWith('/api/') || (c.req.header('Accept') ?? '').includes('application/json');
  if (isApi) {
    return c.json({
      success: false,
      error: {
        code: 'MAINTENANCE_MODE',
        message: info.reason,
        retry_after: info.retry_after,
      },
    }, 503, { 'Retry-After': String(info.retry_after) });
  }

  // HTML for browser requests
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maintenance — EdgePay</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b1f3a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:560px;padding:2rem}
h1{font-size:2rem;margin:0 0 1rem;color:#f38020}
p{color:#94a3b8;line-height:1.6}
</style>
</head>
<body>
<div class="box">
<h1>Maintenance in progress</h1>
<p>${escapeHtml(info.reason)}</p>
<p>Please retry in ${Math.ceil(info.retry_after / 60)} minutes.</p>
</div>
</body>
</html>`, 503, { 'Retry-After': String(info.retry_after) });
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
