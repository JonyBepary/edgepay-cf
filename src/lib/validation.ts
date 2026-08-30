/**
 * Zod request schemas for the money-critical merchant API routes
 * (v0.2.2, audit P2).
 *
 * These routes previously validated with hand-rolled regex checks plus
 * unsafe `c.req.json<T>()` casts. Paired with @hono/zod-validator they
 * now produce a typed `c.req.valid('json')` and automatic 400s. The
 * zValidator hooks in the controllers map failures onto the existing
 * ValidationError (400 / VALIDATION_ERROR) so the API error contract is
 * unchanged for existing clients.
 *
 * Note: `amount` is at most 2 fraction digits — the API contract for
 * money. Internal helpers (lib/money.ts isValidMoney) stay permissive
 * for legacy paths; this is the strict boundary.
 */

import { z } from 'zod';

/** Decimal amount string: optional leading digits, 0-2 fraction digits. */
export const moneySchema = z
  .string({ required_error: 'amount is required', invalid_type_error: 'amount must be a string' })
  .regex(/^\d+(\.\d{1,2})?$/, 'amount must be a valid monetary amount (e.g. "100.50", max 2 fraction digits)');

/** ISO 4217 alphabetic code, case-insensitive (upper-cased by the handler). */
export const currencySchema = z
  .string({ required_error: 'currency is required', invalid_type_error: 'currency must be a string' })
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code');

export const createPaymentSchema = z.object({
  amount: moneySchema,
  currency: currencySchema,
  description: z.string().max(1000).optional(),
  gateway_id: z.number().int().positive().optional(),
  customer: z
    .object({
      name: z.string().max(200).optional(),
      email: z.string().email().optional(),
      phone: z.string().max(30).optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  expires_in_seconds: z.number().int().min(60).max(86400).optional(),
});

export const createRefundSchema = z.object({
  transaction_id: z
    .string({ required_error: 'transaction_id is required', invalid_type_error: 'transaction_id must be a string' })
    .min(1, 'transaction_id is required')
    .max(64),
  amount: moneySchema.optional(),
  reason: z.string().max(500).optional(),
});
