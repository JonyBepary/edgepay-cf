import { execa, type Options } from 'execa';

export interface WranglerOpts {
  json?: boolean;
  silent?: boolean;
  input?: string;
  cwd?: string;
  accountId?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');

  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = trimmed.lastIndexOf('}');
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = trimmed.lastIndexOf(']');
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const jsonStr = trimmed.slice(startIdx, endIdx + 1);
    return JSON.parse(jsonStr) as T;
  }

  return JSON.parse(trimmed) as T;
}

function isTransientError(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.stderr ?? ''} ${err?.stdout ?? ''}`;
  const transientPatterns = [
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /socket hang up/i,
    /status[:\s]+429\b/i,
    /429\s+Too\s+Many\s+Requests/i,
    /status[:\s]+50[0234]\b/i,
    /gateway timeout/i,
    /service unavailable/i,
    /network timeout/i,
    /fetch failed/i,
  ];
  return transientPatterns.some((p) => p.test(msg));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function wrangler<T = unknown>(
  args: string[],
  opts: WranglerOpts = {},
): Promise<T | string> {
  const env: Record<string, string> = {
    ...process.env,
    CI: '1',
    ...(opts.env ?? {}),
  };

  if (opts.accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;
  }

  const execOpts: Options = {
    env,
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 120_000,
    stdio: opts.silent ? 'pipe' : 'inherit',
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  };

  let lastError: any = null;
  const maxAttempts = Number(process.env.EDGEPAY_RETRY_ATTEMPTS ?? 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await execa('npx', ['wrangler', ...args], execOpts);
      const stdoutStr = String(result.stdout ?? '');

      if (opts.json) {
        try {
          return extractJson<T>(stdoutStr);
        } catch (err) {
          throw new Error(`Failed to parse JSON from wrangler output: ${stdoutStr} (${String(err)})`);
        }
      }

      return stdoutStr;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        const backoffMs = 2000 * Math.pow(2, attempt - 1);
        await delay(backoffMs);
        continue;
      }
      break;
    }
  }

  const stderr = lastError?.stderr ? String(lastError.stderr).trim() : '';
  const stdout = lastError?.stdout ? String(lastError.stdout).trim() : '';
  const detail = stderr || stdout || lastError?.message || 'Unknown error';
  throw new Error(`wrangler ${args.join(' ')} failed:\n${detail}`);
}

export interface WhoamiAccount {
  id: string;
  name: string;
}

export interface WhoamiResult {
  loggedIn: boolean;
  email?: string;
  accounts: WhoamiAccount[];
}

export async function whoami(accountId?: string): Promise<WhoamiResult | null> {
  try {
    const res = await wrangler<WhoamiResult>(['whoami', '--json'], {
      json: true,
      silent: true,
      accountId,
    });
    if (typeof res === 'object' && res !== null && Array.isArray(res.accounts)) {
      return res;
    }
    return null;
  } catch {
    return null;
  }
}

export async function login(): Promise<void> {
  const isRemote = Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY,
  );
  if (isRemote) {
    console.log('\n[Remote Session Detected] Launching wrangler login with --browser=false...\n');
    await execa('npx', ['wrangler', 'login', '--browser=false'], {
      stdio: 'inherit',
      env: { ...process.env, CI: '0' },
    });
    return;
  }

  await execa('npx', ['wrangler', 'login'], {
    stdio: 'inherit',
    env: { ...process.env, CI: '0' },
  });
}

export interface EnsureResourceOpts {
  accountId?: string;
  expectedExistingId?: string;
  adoptExisting?: boolean;
  _executor?: (args: string[], opts?: any) => Promise<any>;
}

export async function ensureD1(name: string, opts: EnsureResourceOpts = {}): Promise<string> {
  const accountId = opts.accountId;
  const runWrangler = opts._executor ?? wrangler;
  try {
    const list = await runWrangler<Array<{ name: string; uuid: string }>>(
      ['d1', 'list', '--json'],
      { json: true, silent: true, accountId },
    );
    if (Array.isArray(list)) {
      const existing = list.find((d) => d.name === name);
      if (existing?.uuid) {
        if (
          (opts.expectedExistingId && opts.expectedExistingId === existing.uuid) ||
          opts.adoptExisting
        ) {
          return existing.uuid;
        }
        throw new Error(
          `Cannot provision D1 database "${name}": a database with this name already exists in Cloudflare account ${accountId ?? ''} (UUID: ${existing.uuid}). Refusing to adopt existing Cloudflare resource.\nTo adopt pre-existing Cloudflare resources into this deployment, re-run with: --adopt-existing-resources\nAlternatively, choose a different deployment name or delete the existing database manually.`,
        );
      }
    }
  } catch (err: any) {
    if (err.message?.includes('Refusing to adopt')) {
      throw err;
    }
  }

  const createOutput = (await runWrangler(['d1', 'create', name], {
    silent: true,
    accountId,
  })) as string;

  try {
    const parsed = extractJson<{ database_id?: string; uuid?: string }>(createOutput);
    const resolvedId = parsed.database_id ?? parsed.uuid;
    if (resolvedId) return resolvedId;
  } catch {
    // fall back to regex
  }

  const match = createOutput.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (match) {
    return match[1];
  }

  throw new Error(`Failed to resolve D1 database UUID for ${name}. Output: ${createOutput}`);
}

export async function ensureKv(title: string, opts: EnsureResourceOpts = {}): Promise<string> {
  const accountId = opts.accountId;
  const runWrangler = opts._executor ?? wrangler;
  try {
    // Note: wrangler kv namespace list returns JSON by default; passing --json is an error in wrangler v4
    const rawList = (await runWrangler(['kv', 'namespace', 'list'], {
      silent: true,
      accountId,
    })) as string;
    const list = extractJson<Array<{ id: string; title: string }>>(rawList);
    if (Array.isArray(list)) {
      const existing = list.find((k) => k.title === title);
      if (existing?.id) {
        if (
          (opts.expectedExistingId && opts.expectedExistingId === existing.id) ||
          opts.adoptExisting
        ) {
          return existing.id;
        }
        throw new Error(
          `Cannot provision KV namespace "${title}": a namespace with this title already exists in Cloudflare account ${accountId ?? ''} (ID: ${existing.id}). Refusing to adopt existing Cloudflare resource.\nTo adopt pre-existing Cloudflare resources into this deployment, re-run with: --adopt-existing-resources\nAlternatively, choose a different deployment name or delete the existing namespace manually.`,
        );
      }
    }
  } catch (err: any) {
    if (err.message?.includes('Refusing to adopt')) {
      throw err;
    }
  }

  const createOutput = (await runWrangler(['kv', 'namespace', 'create', title], {
    silent: true,
    accountId,
  })) as string;

  try {
    const parsed = extractJson<{ id?: string }>(createOutput);
    if (parsed.id) return parsed.id;
  } catch {
    // fall back to regex
  }

  const match = createOutput.match(/id:\s+"([a-f0-9]+)"/i) ?? createOutput.match(/([a-f0-9]{32})/i);
  if (match) {
    return match[1];
  }

  throw new Error(`Failed to resolve KV namespace ID for ${title}. Output: ${createOutput}`);
}

export async function ensureR2(name: string, opts: EnsureResourceOpts = {}): Promise<string> {
  const accountId = opts.accountId;
  const runWrangler = opts._executor ?? wrangler;
  try {
    const rawList = (await runWrangler(['r2', 'bucket', 'list'], {
      silent: true,
      accountId,
    })) as string;
    const lines = rawList.split('\n');
    const existing = lines.some((l) => {
      const match = l.match(/name:\s+(\S+)/);
      return match && match[1] === name;
    });
    if (existing) {
      if (
        (opts.expectedExistingId && opts.expectedExistingId === name) ||
        opts.adoptExisting
      ) {
        return name;
      }
      throw new Error(
        `Cannot provision R2 bucket "${name}": a bucket with this name already exists in Cloudflare account ${accountId ?? ''}. Refusing to adopt existing Cloudflare resource.\nTo adopt pre-existing Cloudflare resources into this deployment, re-run with: --adopt-existing-resources\nAlternatively, choose a different deployment name or delete the existing bucket manually.`,
      );
    }
  } catch (err: any) {
    if (err.message?.includes('Refusing to adopt')) {
      throw err;
    }
  }

  try {
    await runWrangler(['r2', 'bucket', 'create', name], {
      silent: true,
      accountId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('already exists')) {
      throw err;
    }
  }

  return name;
}

export function parseQueueList(rawOutput: string): Array<{ id?: string; name: string }> {
  try {
    const json = extractJson<Array<{ id?: string; name: string }>>(rawOutput);
    if (Array.isArray(json)) {
      return json.filter((q) => Boolean(q?.name));
    }
  } catch {
    // fall through to table parsing
  }

  const queues: Array<{ id?: string; name: string }> = [];
  const lines = rawOutput.split('\n');
  for (const line of lines) {
    if (!line.includes('│')) continue;
    const parts = line.split('│').map((p) => p.trim());
    // Table format: | id | name | created_on | modified_on | producers | consumers |
    // parts[0] is empty (before first |)
    // parts[1] is 'id' or uuid
    // parts[2] is 'name' or queue name
    if (
      parts.length >= 3 &&
      parts[1].toLowerCase() !== 'id' &&
      parts[2].toLowerCase() !== 'name' &&
      parts[2].length > 0
    ) {
      queues.push({ id: parts[1], name: parts[2] });
    }
  }

  if (queues.length === 0 && /name/i.test(rawOutput)) {
    console.warn('[WARN] parseQueueList: Table output contained "name" but parsed 0 queues. Cloudflare table format may have changed.');
  }

  return queues;
}

export async function ensureQueue(name: string, opts: EnsureResourceOpts = {}): Promise<string> {
  const accountId = opts.accountId;
  const runWrangler = opts._executor ?? wrangler;
  try {
    const rawList = (await runWrangler(['queues', 'list'], {
      silent: true,
      accountId,
    })) as string;
    const queues = parseQueueList(rawList);
    const existing = queues.find((q) => q.name === name);
    if (existing) {
      if (
        (opts.expectedExistingId && opts.expectedExistingId === name) ||
        opts.adoptExisting
      ) {
        return name;
      }
      throw new Error(
        `Cannot provision Queue "${name}": a queue with this name already exists in Cloudflare account ${accountId ?? ''}. Refusing to adopt existing Cloudflare resource.\nTo adopt pre-existing Cloudflare resources into this deployment, re-run with: --adopt-existing-resources\nAlternatively, choose a different deployment name or delete the existing queue manually.`,
      );
    }
  } catch (err: any) {
    if (err.message?.includes('Refusing to adopt')) {
      throw err;
    }
  }

  try {
    await runWrangler(['queues', 'create', name], {
      silent: true,
      accountId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('already exists')) {
      throw err;
    }
  }

  return name;
}

/**
 * Classifies Cloudflare errors during resource deletion.
 *
 * PROVISIONAL IMPLEMENTATION:
 * Calibrated against live-captured Cloudflare v4 CLI / API responses:
 * - D1: "Couldn't find a D1 DB with name or binding" or REST API code 7000
 * - KV: "namespace not found [code: 10013]"
 * - R2: "The specified bucket does not exist. [code: 10006]"
 * - Queues: 'Queue "..." does not exist'
 *
 * Explicitly rejects non-404 errors (auth 10000, permission 10007, user 10008, account 10002).
 * Covered by live fixture tests in packages/init/tests/installer.test.ts (Cloudflare Error Classification & isNotFound).
 */
export function isNotFound(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.stderr ?? ''} ${err?.stdout ?? ''}`;

  // Explicitly disallow permission/auth errors from being treated as not found
  if (/permission\s+denied|unauthorized|forbidden|authentication\s+error|\b(10000|10007)\b/i.test(msg)) {
    return false;
  }
  // Explicitly disallow user/account errors
  if (/user\s+not\s+found|account\s+not\s+found|\b(10002|10008)\b/i.test(msg)) {
    return false;
  }

  // Real captured Cloudflare API & Wrangler v4 CLI error patterns:
  // - D1: "Couldn't find a D1 DB with name or binding" or "database not found [code: 7000]"
  // - KV: "namespace not found [code: 10013]"
  // - R2: "The specified bucket does not exist. [code: 10006]"
  // - Queues: 'Queue "..." does not exist' or 'could not find queue'
  const capturedNotFoundPatterns = [
    /Couldn't\s+find\s+a\s+D1\s+DB/i,
    /database\s+not\s+found\s*\[code:\s*7000\]/i,
    /namespace\s+not\s+found\s*\[code:\s*10013\]/i,
    /The\s+specified\s+bucket\s+does\s+not\s+exist\.?\s*\[code:\s*10006\]/i,
    /Queue\s+["'].*?["']\s+does\s+not\s+exist/i,
    /could\s+not\s+find\s+(database|namespace|queue|bucket)/i,
  ];
  return capturedNotFoundPatterns.some((p) => p.test(msg));
}

export async function deleteD1(name: string, accountId?: string): Promise<void> {
  try {
    await wrangler(['d1', 'delete', name, '--skip-confirmation'], {
      silent: true,
      accountId,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function deleteKv(idOrTitle: string, accountId?: string): Promise<void> {
  let id = idOrTitle;
  if (!/^[a-f0-9]{32}$/i.test(idOrTitle)) {
    try {
      const rawList = (await wrangler(['kv', 'namespace', 'list'], {
        silent: true,
        accountId,
      })) as string;
      const list = extractJson<Array<{ id: string; title: string }>>(rawList);
      if (Array.isArray(list)) {
        const found = list.find((k) => k.title === idOrTitle);
        if (!found) return;
        id = found.id;
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return;
    }
  }

  try {
    await wrangler(['kv', 'namespace', 'delete', '--namespace-id', id], {
      silent: true,
      accountId,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function deleteR2(name: string, accountId?: string): Promise<void> {
  try {
    await wrangler(['r2', 'bucket', 'delete', name], {
      silent: true,
      accountId,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function deleteQueue(name: string, accountId?: string): Promise<void> {
  try {
    await wrangler(['queues', 'delete', name], {
      silent: true,
      accountId,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
