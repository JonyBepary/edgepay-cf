/**
 * D1 query builder — thin wrapper around D1PreparedStatement with:
 *   - Strong typing on row shape
 *   - Query logging (rows_read, rows_written) for cost monitoring
 *   - Error normalization (D1 throws raw Error objects)
 *
 * D1 is a read-replica SQLite service. Writes propagate to the primary
 * and may take 50-200ms to be visible on read replicas. For strongly
 * consistent reads (e.g. immediately after a payment write), use the
 * `withPrimary()` helper — currently D1 does not expose a "force primary"
 * flag, so we work around this with KV cache invalidation patterns.
 */

import type { Env, D1PreparedStatement, D1Result } from '../types/env';
import { HttpError, ServiceUnavailableError } from './error';

export interface QueryOptions {
  /** Force reading from primary (for post-write consistency) */
  preferPrimary?: boolean;
  /** Skip cost logging for high-frequency queries */
  skipCostLog?: boolean;
}

export class Database {
  constructor(
    private readonly env: Env,
    private readonly logCost: boolean = true,
  ) {}

  /**
   * Prepare a statement. Returns a wrapped PreparedStatement that
   * logs D1 cost metadata on .all() / .first() / .run().
   */
  prepare(sql: string, params: unknown[] = []): PreparedStatement {
    return new PreparedStatement(this.env.DB.prepare(sql), params, this.env, this.logCost);
  }

  /**
   * Run multiple statements in a single D1 round-trip (batch).
   * Useful for multi-row inserts.
   */
  async batch(statements: PreparedStatement[]): Promise<D1Result[]> {
    try {
      return await this.env.DB.batch(statements.map(s => s.stmt));
    } catch (err) {
      throw normalizeD1Error(err);
    }
  }

  /**
   * Run raw SQL (DDL, multi-statement migrations).
   * Used by migrations only — NOT for query data.
   */
  async exec(sql: string): Promise<void> {
    try {
      await this.env.DB.exec(sql);
    } catch (err) {
      throw normalizeD1Error(err);
    }
  }

  /**
   * Transaction — D1 does NOT support interactive transactions
   * (BEGIN/COMMIT round-trips). The workaround is a single batch()
   * call with multiple statements — D1 wraps batches in an implicit
   * transaction: if any statement fails, all are rolled back.
   */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return work(new Transaction(this));
  }
}

export class Transaction {
  constructor(private readonly db: Database) {}

  prepare(sql: string, params: unknown[] = []): PreparedStatement {
    return this.db.prepare(sql, params);
  }

  /**
   * Commit all statements in a single D1 batch (atomic).
   * D1 batches are wrapped in an implicit transaction.
   */
  async commit(statements: PreparedStatement[]): Promise<D1Result[]> {
    return this.db.batch(statements);
  }
}

export class PreparedStatement {
  public readonly stmt: D1PreparedStatement;

  constructor(
    stmt: D1PreparedStatement,
    params: unknown[],
    _env: Env,
    private readonly logCost: boolean,
  ) {
    this.stmt = params.length > 0 ? stmt.bind(...params) : stmt;
  }

  async first<T = unknown>(col?: string): Promise<T | null> {
    try {
      const result = await this.stmt.first<T>(col);
      this.logCostMeta('first');
      return result;
    } catch (err) {
      throw normalizeD1Error(err);
    }
  }

  async all<T = unknown>(): Promise<T[]> {
    try {
      const result = await this.stmt.all<T>();
      this.logCostMeta('all', result.meta);
      return result.results ?? [];
    } catch (err) {
      throw normalizeD1Error(err);
    }
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    try {
      const result = await this.stmt.run<T>();
      this.logCostMeta('run', result.meta);
      return result;
    } catch (err) {
      throw normalizeD1Error(err);
    }
  }

  /**
   * Structured debug log of D1 cost metadata (rows_read / rows_written —
   * the two numbers the free tier bills against). Cheap, sampled by
   * Workers Logs; never throws.
   */
  private logCostMeta(
    op: string,
    meta?: { rows_read?: number; rows_written?: number; duration?: number },
  ): void {
    if (!this.logCost) return;
    try {
      console.log(JSON.stringify({
        level: 'debug',
        event: 'd1_query_cost',
        op,
        rows_read: meta?.rows_read ?? 0,
        rows_written: meta?.rows_written ?? 0,
        duration_ms: meta?.duration ?? 0,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // logging must never break the query path
    }
  }
}

function normalizeD1Error(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  // Detect common D1 outages
  if (/database is locked|cannot start a transaction/i.test(message)) {
    return new ServiceUnavailableError('Database temporarily unavailable — please retry');
  }
  if (/no such table|no such column|SQLITE_ERROR/i.test(message)) {
    return new HttpError(500, `Schema error: ${message}`, 'DATABASE_SCHEMA_ERROR');
  }
  return new HttpError(500, `Database error: ${message}`, 'DATABASE_ERROR');
}
