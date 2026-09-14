#!/usr/bin/env python3
"""
scripts/extract-queue-timeline.py

Audits Wrangler CLI log files (~/.config/.wrangler/logs/wrangler-2026-09-14_*.log)
and extracts a chronological ledger of all Cloudflare queue operations
(CREATE, DELETE, CONSUMER_REMOVE, and LIST).

Usage:
  python3 scripts/extract-queue-timeline.py [output_file]
"""

import glob
import os
import re
import sys

def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'evidence/queue_timeline.txt'
    log_dir = os.path.expanduser('~/.config/.wrangler/logs')
    log_files = sorted(glob.glob(os.path.join(log_dir, 'wrangler-2026-09-14_*.log')))

    if not log_files:
        print(f"No Wrangler logs found matching wrangler-2026-09-14_*.log in {log_dir}")
        sys.exit(1)

    events = []

    for path in log_files:
        filename = os.path.basename(path)
        with open(path, 'r', errors='ignore') as f:
            content = f.read()

        # Find timestamp
        ts_match = re.search(r'2026-09-14T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', content)
        ts = ts_match.group(0) if ts_match else 'UNKNOWN'

        # Check for queue operations
        # 1. Created queue
        created = re.findall(r'Created queue [\'"]([^\'"]+)[\'"]', content)
        for q in created:
            events.append((ts, filename, 'CREATE', q, 'Queue created'))

        # 2. Deleting queue
        deleting = re.findall(r'Deleting queue ([^\.\s]+)', content)
        deleted = re.findall(r'Deleted queue ([^\.\s]+)', content)
        for q in deleting:
            status = 'SUCCESS' if q in deleted else 'ATTEMPT/FAIL'
            events.append((ts, filename, 'DELETE', q, f'Queue deletion ({status})'))

        # 3. Consumer remove
        consumer_rem = re.findall(r'Removing consumer from queue ([^\.\s]+)', content)
        for q in consumer_rem:
            events.append((ts, filename, 'CONSUMER_REMOVE', q, 'Consumer detach attempt'))

        # 4. Queues list table
        if '┌──────────────────────────────────┬' in content:
            rows = re.findall(r'│\s*([0-9a-f]{32})\s*│\s*([a-zA-Z0-9_\-]+)\s*│\s*([0-9\-T:\.Z]+)\s*│', content)
            if rows:
                for rid, rname, rcreated in rows:
                    events.append((ts, filename, 'LIST', rname, f'ID: {rid[:8]}... Created: {rcreated}'))

    events.sort(key=lambda x: (x[0], x[1]))

    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w') as out:
        out.write("# Forensic timeline of all Cloudflare queue operations on account\n")
        out.write("# 17347346d8cc54bbb820a0a0413d98c0 between 2026-09-14 02:00 and 06:00 UTC.\n#\n")
        out.write("# Regenerate with: python3 scripts/extract-queue-timeline.py\n\n")
        out.write(f"Total Wrangler log files inspected: {len(log_files)}\n")
        out.write(f"Total Queue events recorded: {len(events)}\n\n")
        out.write("| Log Timestamp (UTC) | Log File | Action | Target / Queue Name | Details |\n")
        out.write("| :--- | :--- | :--- | :--- | :--- |\n")
        for ts, fname, action, target, detail in events:
            out.write(f"| `{ts}` | `{fname}` | `{action}` | `{target}` | {detail} |\n")

    print(f"Recorded {len(events)} events in {out_path}")

if __name__ == '__main__':
    main()
