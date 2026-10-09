#!/usr/bin/env python3
"""Read official orders and optional benefits, then build a private journal."""
import argparse
import getpass
import os
import sys
from urllib.error import HTTPError, URLError

from connect_mcp import OUTPUT, save_private
from import_mcp_footprints import normalize, read_result
from mcp_readonly import Client
from render_footprints import render


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prompt-token', action='store_true')
    parser.add_argument('--order-offset', required=True, help='explicit offset for order times lacking timezone, e.g. +08:00')
    parser.add_argument('--with-benefits', action='store_true', help='read coupons and campaigns; never claim coupons')
    args = parser.parse_args()
    token = os.environ.get('MCD_MCP_TOKEN', '').strip()
    if not token and args.prompt_token:
        if not sys.stdin.isatty():
            parser.exit(2, 'Use a local terminal for --prompt-token, or bind MCD_MCP_TOKEN as an environment secret.\n')
        try:
            token = getpass.getpass('MCP Token（不回显、不保存）：').strip()
        except (EOFError, KeyboardInterrupt):
            parser.exit(2, '\nToken entry cancelled.\n')
    try:
        client = Client(token)
        client.initialize()
        tools = {tool['name']: tool for tool in client.tools()}

        def fetch(name, arguments, filename):
            if name not in tools:
                raise ValueError('required read-only tool is unavailable')
            required = tools[name]['inputSchema'].get('required', [])
            if not set(required).issubset(arguments):
                raise ValueError('current schema requires additional explicit arguments')
            result = client.rpc('tools/call', {'name': name, 'arguments': arguments})
            if result.get('isError') or result.get('structuredContent', {}).get('success') is not True:
                raise ValueError('official read failed; no synthetic fallback')
            save_private(filename, result)
            print(name + ': succeeded; saved privately.', flush=True)

        # Delete only generated cached responses so old records are never mixed
        # into a new successful query. A failed run does not produce a report.
        for path in OUTPUT.glob('order-detail-*.json'):
            path.unlink()
        for name in ['available-coupons', 'campaign-calendar']:
            path = OUTPUT / (name + '.result.json')
            if path.exists():
                path.unlink()
        fetch('now-time-info', {}, 'now-time-info.result.json')
        fetch('order-list', {}, 'order-list.result.json')
        listing = read_result(OUTPUT / 'order-list.result.json')
        if len(listing['list']) > 100:
            raise ValueError('large response requires an explicit query plan; no incomplete automatic run')
        for index, row in enumerate(listing['list'], 1):
            fetch('query-order', {'orderId': row['orderId']}, f'order-detail-{index:02d}.json')
        if args.with_benefits:
            fetch('available-coupons', {}, 'available-coupons.result.json')
            fetch('campaign-calendar', {}, 'campaign-calendar.result.json')
        payload = normalize(OUTPUT, args.order_offset)
        save_private('footprints.normalized.json', payload)
        page, plain, summary = render(payload)
        save_private('footprints.summary.json', summary)
        for name, content in [('footprints.html', page), ('footprints.txt', plain)]:
            path = OUTPUT / name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(content)
            os.chmod(path, 0o600)
        print('Real journal generated: private/mcp/footprints.html')
    except HTTPError as error:
        parser.exit(2, f'Official MCP HTTP {error.code}; no report generated.\n')
    except (ValueError, KeyError, TypeError, OSError, URLError):
        parser.exit(2, 'Connection, input or observed schema failed; no new report generated. Inspect local private responses.\n')


if __name__ == '__main__':
    main()
