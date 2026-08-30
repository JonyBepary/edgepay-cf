# The Ledger Posting Protocol (v0.2.1)

This document is the normative spec for how money moves through EdgePay-CF. It
resolves the two critical findings from the architecture review:

1. **The cross-system atomicity gap** — v0.2.0 fanned each posting out to N
   per-account Durable Objects plus a D1 batch: three systems, no atomicity
   between them. Partial failure either broke the trial balance or moved
   balances with no audit trail.
2. **The disabled balance guard** — v0.2.0 shipped the balance check commented
   out, making the DO a serialized *accumulator* rather than a *guard*.

## The rule

**ONE Durable Object per merchant (`LedgerDO`) owns ALL of that merchant's
ledger accounts.** A multi-account posting (clearing + revenue + fees) is a
single, serialized, idempotent call into that DO. There is no cross-DO fan-out,
and therefore no cross-DO atomicity problem to solve.

Per-account DOs solve a contention problem this system does not have (no
single merchant's payment rate comes close to saturating one DO), at the cost
of the atomicity problem it does.

## The protocol

`LedgerDO.postTransaction(payload)` — every step inside `blockConcurrencyWhile`,
which makes the DO the single writer for the tenant's entire book:

```
A. Shape validation (pure)      Σdebits == Σcredits, ≥2 entries,
                                positive safe-integer minor units
B. Dedup by tx_id               posted_transactions table (in-DO SQLite)
C. Balance guard  ← THE FIX     resulting per-account balances may never go
                                negative on the account's normal side;
                                rejects INSUFFICIENT_FUNDS *before any write*
D. D1 write-ahead row           op_ledger_postings INSERT status='pending'
                                (ON CONFLICT DO NOTHING — replay-tolerant;
                                'rejected' status = poison guard)
E. DO journal + balances        posted_transactions + journal_entries rows +
                                accounts.balance_minor updates (in-DO SQLite;
                                commit when the event completes)
F. D1 audit trail + flip        op_ledger_transactions/entries batch (idempotent
                                guards) + postings status → 'posted'
```

The `tx_id` is the idempotency key (`m{merchant_id}:{kind}:{reference}`).
Webhook redeliveries, workflow retries, client retries and reconciliation
replays all converge on the same key.

## Failure matrix

Empirically confirmed against real workerd by the integration suite
(`tests/ledger-do.test.ts`):
- a THROW out of `blockConcurrencyWhile` breaks the DO's input gate — every
  subsequent call to the tenant's ledger fails until eviction. Therefore
  `postTransaction` NEVER throws; failures are structured results and
  `LedgerService` re-scaffolds exceptions worker-side.
- DO storage writes made during an event that COMPLETES (even one returning
  a `failed` result) are COMMITTED. There is no rollback to lean on — and the
  protocol doesn't need one:

| Failure point | D1 (write-ahead) | DO (balances+journal) | Caller sees | Recovery |
|---|---|---|---|---|
| A/B/C rejects | nothing | nothing | `{status:'failed', error_code}` → worker-side `PostingValidationError` | none needed — client error |
| **D fails** | nothing* | nothing | `failed` (`INTERNAL`) | client retries same tx_id — clean |
| **E fails before writes** | `pending` row | nothing written | `failed` (`INTERNAL`) | replay posts it fresh |
| **F fails** (or isolate dies after E commits) | `pending` row | applied (committed) | `failed` (`INTERNAL`) | replay → dedup `duplicate` → audit-trail rewrite + flip to `posted` (heal) |
| Hard crash mid-event | `pending` row* | unwritten changes discarded (event never completed) | dropped connection | replay posts it fresh |
| D1 ahead of DO (crash between D and E commit) | `posted` or `pending` | rolled back | dropped connection | replay: dedup miss → re-post; audit writes are `ON CONFLICT`-guarded |
| Replay deterministically invalid | quarantined `rejected` | — | — | operator inspects + re-issues; DO refuses to resurrect the tx_id (`REJECTED_TX_ID`) |

\* If D itself partially landed, D1's single-statement insert is atomic —
there is no partial-D state.

## The recovery half (services/reconciliation.ts)

`reconcilePendingPostings()` (hourly cron + daily sweep workflow + manual ops
trigger) reads `op_ledger_postings WHERE status='pending'` past a 30s grace
window and replays the stored canonical payload (`payload_json`) through the
same protocol:

- **DO never applied it** (crash windows D/E/F) → replay posts it. Idempotent
  by tx_id.
- **DO applied but D1 audit never landed** (the exotic heal window) → replay
  returns `duplicate` → reconciliation re-runs `writeLedgerAuditTrail()`
  (every statement guarded) and flips the row to `posted`.
- **Deterministically invalid payload** (`UNBALANCED`, `UNKNOWN_ACCOUNT`,
  `CURRENCY_MISMATCH`, …) → quarantined as `rejected` with the error, and a
  **page** fires. Rejected rows are never silently retried; an operator
  inspects and re-issues. The DO also refuses to resurrect a rejected tx_id
  (`REJECTED_TX_ID`).
- **Transient failure** → `attempts` bumped; after 5 attempts → quarantined +
  page.

`verifyAllMerchants()` (daily) asserts the standing property for every active
merchant: **D1-aggregated balances == DO balances, per account, and each
tenant's Σdebits == Σcredits** (aggregated in integer minor units — never SQL
`SUM()` on the TEXT audit mirror). Any drift **pages**; reconciliation drift
is an incident, not a log line.

`tests/ledger-do.test.ts` and `tests/ledger-consistency.test.ts` exercise this
entire matrix against a real DO + real D1 inside workerd, including
failure injection at every seam (`__testInjectFault`, the documented test
surface) and N-parallel posting storms.

## Money representation

Inside the DO, money is **INTEGER minor units** (paisa/cents) so SQL
aggregation and comparisons are numerically correct. The D1 audit mirror
keeps the legacy TEXT decimal strings for backward compatibility with
existing reporting — the mirror is *derived* state, never the arithmetic
source of truth.

## Throughput & cost notes

One posting = 1 DO request (plus reads) with a few in-DO SQLite ops and one
D1 batch. This sustains far more than any single merchant's payment rate; do
not split per-account (it reintroduces the atomicity gap and costs ~3× the DO
requests). At 10K tx/day this is ≈310K DO requests/month — comfortably inside
the 100K/day free-tier DO request budget up to ~5K tx/day, and well under $1/mo
on Workers Paid beyond that.
