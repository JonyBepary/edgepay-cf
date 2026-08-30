/**
 * Default chart of accounts — single source of truth shared by:
 *   - LedgerService.createDefaultChartOfAccounts()  → D1 rows (reporting/joins)
 *   - LedgerDO.seedChart() (tables in ctor)                       → in-DO SQLite (authoritative balances)
 *
 * The chart is TENANT-CONTAINED by design (review decision #1):
 * every account belongs to a merchant's own book. Platform revenue
 * (code 4100/5000 flows) is computed as an aggregate query across
 * merchants — the Stripe-style per-account ledger model.
 *
 * Inside the DO, balances are INTEGER minor units (paisa/cents) so
 * SQL SUM()/ORDER BY are numerically correct. TEXT money strings in
 * D1 are only a backward-compatible audit mirror.
 */

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface ChartAccount {
  code: string;
  name: string;
  type: LedgerAccountType;
}

export const DEFAULT_CHART_OF_ACCOUNTS: ChartAccount[] = [
  { code: '1000', name: 'Cash at Bank', type: 'asset' },
  { code: '1010', name: 'Gateway Clearing', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '1200', name: 'Prepaid Fees', type: 'asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'Customer Credits', type: 'liability' },
  { code: '2200', name: 'Refunds Payable', type: 'liability' },
  { code: '3000', name: 'Owner Equity', type: 'equity' },
  { code: '3100', name: 'Retained Earnings', type: 'equity' },
  { code: '4000', name: 'Payment Revenue', type: 'revenue' },
  { code: '4100', name: 'Gateway Fees Revenue', type: 'revenue' },
  { code: '5000', name: 'Gateway Fees Expense', type: 'expense' },
  { code: '5100', name: 'Refund Expense', type: 'expense' },
  { code: '5200', name: 'Chargeback Expense', type: 'expense' },
];

/** Debit-normal account types (asset/expense); all others are credit-normal. */
export function isDebitNormal(type: LedgerAccountType): boolean {
  return type === 'asset' || type === 'expense';
}
