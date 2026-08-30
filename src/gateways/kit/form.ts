/**
 * Auto-submit HTML form builder — the redirect archetype used by ~60 ported
 * gateways (Rocket, CCAvenue, PayU, ...). The customer's browser POSTs
 * signed fields straight to the provider, equivalent to the PHP adapters'
 * inline `<form><script>submit()</script>` payloads.
 *
 * Escaping: every value passes through escapeHtml (the PHP used
 * htmlspecialchars) — a credential or trx_id containing quotes must never
 * break out of the attribute.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Build an auto-submitting POST form. Field order is preserved (some
 * providers' docs specify ordering; harmless otherwise).
 */
export function buildAutoSubmitForm(
  action: string,
  fields: Record<string, string>,
  options: { formId?: string } = {},
): string {
  const formId = options.formId ?? 'edgepay-gateway-form';
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(String(value ?? ''))}">`,
    )
    .join('\n        ');

  return `<form action="${escapeHtml(action)}" method="POST" id="${escapeHtml(formId)}">
        ${inputs}
      </form>
      <script>document.getElementById("${escapeHtml(formId)}").submit();</script>`;
}
