/**
 * Logger — structured JSON logger compatible with Cloudflare Workers.
 *
 * Workers have no stdout/stderr concept — `console.log` and friends are
 * captured by the runtime and routed to wrangler tail (dev) or
 * Logpush (production). For structured observability, we emit JSON
 * with consistent fields.
 *
 * Levels (per env.LOG_LEVEL):
 *   debug: dev only — full request/response bodies
 *   info: normal ops — startup, route hits, scheduled jobs
 *   warn: degraded — rate limits, fallbacks, retries
 *   error: ops action — failed requests, gateway errors
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...redact(context),
    };

    // Workers console.* routes to wrangler tail / Logpush
    const stringified = JSON.stringify(entry);
    switch (level) {
      case 'debug': console.debug(stringified); break;
      case 'info':  console.info(stringified);  break;
      case 'warn':  console.warn(stringified);  break;
      case 'error': console.error(stringified); break;
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.emit('error', message, context);
  }

  /** Create a child logger that always includes the given context fields */
  child(context: Record<string, unknown>): Logger {
    const parentEmit = this.emit.bind(this);
    const childLogger = new Logger(this.minLevel);
    // Override emit to merge context
    (childLogger as unknown as { emit: typeof parentEmit }).emit = (
      level: LogLevel,
      message: string,
      ctx?: Record<string, unknown>,
    ) => parentEmit(level, message, { ...context, ...ctx });
    return childLogger;
  }
}

/**
 * Create a Logger instance from the Worker env's LOG_LEVEL.
 */
export function createLogger(level: string = 'info'): Logger {
  return new Logger(level as LogLevel);
}

/** Keys whose values must never reach logs — replaced with [REDACTED]. */
const REDACTED_KEYS = new Set([
  'sender',
  'phone',
  'phone_number',
  'email',
  'trx_id',
  'transaction_id',
  'api_key',
  'apikey',
  'authorization',
]);

/**
 * Recursively redact sensitive fields in a log context object.
 * Denylist: sender / phone / email / trx_id / api_key / Authorization.
 */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
