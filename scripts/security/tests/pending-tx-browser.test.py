#!/usr/bin/env python3
"""Real-browser regression for same-origin send/swap lock arbitration.

Run with: python3 scripts/security/tests/pending-tx-browser.test.py
Requires Python Playwright and Chromium (the same prerequisites as ui-check.py).
Only a fake local signature record is written; no wallet, RPC, or chain call is used.
"""
import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
OWNER = "11111111111111111111111111111111"
PENDING_KEY = f"mono.pending-tx.v1:devnet:{OWNER}"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_server(url, process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Vite exited early with status {process.returncode}")
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return
        except Exception:
            time.sleep(0.2)
    raise TimeoutError("Vite dev server did not start in 30 seconds")


def main():
    port = free_port()
    base = f"http://127.0.0.1:{port}/"
    server = subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(base, server)
        with sync_playwright() as playwright:
            executable = os.environ.get("CHROMIUM_EXECUTABLE_PATH") or shutil.which("chromium")
            launch_options = {"args": ["--no-sandbox"]}
            if executable:
                launch_options["executable_path"] = executable
            browser = playwright.chromium.launch(**launch_options)
            try:
                context = browser.new_context()
                first = context.new_page()
                second = context.new_page()
                first.goto(base, wait_until="domcontentloaded")
                second.goto(base, wait_until="domcontentloaded")
                lock_api = first.evaluate("() => ({ available: !!navigator.locks, secure: isSecureContext })")
                if not lock_api["available"]:
                    raise AssertionError(f"navigator.locks unavailable: {lock_api}")

                first.evaluate(
                    """async ({ owner, key }) => {
                      const { withPendingTransactionLock, savePendingTransaction } = await import('/src/lib/pendingTx.ts');
                      localStorage.removeItem(key);
                      localStorage.removeItem('__mono_pending_tx_browser_ops');
                      window.__pendingTxBrowserFirst = withPendingTransactionLock(owner, 'devnet', async () => {
                        const count = Number(localStorage.getItem('__mono_pending_tx_browser_ops') || '0') + 1;
                        localStorage.setItem('__mono_pending_tx_browser_ops', String(count));
                        await new Promise(resolve => setTimeout(resolve, 700));
                        savePendingTransaction({
                          version: 1,
                          network: 'devnet',
                          owner,
                          signature: '3'.repeat(64),
                          blockhash: 'browser-test-blockhash',
                          lastValidBlockHeight: 123,
                          createdAt: Date.now(),
                          kind: 'sol',
                        });
                        return 'simulated-local-operation';
                      });
                      return true;
                    }""",
                    {"owner": OWNER, "key": PENDING_KEY},
                )
                first.wait_for_function(
                    "localStorage.getItem('__mono_pending_tx_browser_ops') === '1'",
                    timeout=5000,
                )

                active_result = second.evaluate(
                    """async (owner) => {
                      const { withPendingTransactionLock } = await import('/src/lib/pendingTx.ts');
                      return await withPendingTransactionLock(owner, 'devnet', async () => {
                        localStorage.setItem('__mono_pending_tx_browser_ops', 'unexpected-second-operation');
                        return 'wrong';
                      });
                    }""",
                    OWNER,
                )
                first_result = first.evaluate("async () => await window.__pendingTxBrowserFirst")
                second.wait_for_function(f"localStorage.getItem('{PENDING_KEY}') !== null", timeout=5000)
                pending_result = second.evaluate(
                    """async (owner) => {
                      const { withPendingTransactionLock } = await import('/src/lib/pendingTx.ts');
                      return await withPendingTransactionLock(owner, 'devnet', async () => 'must-not-run');
                    }""",
                    OWNER,
                )
                operation_count = first.evaluate("localStorage.getItem('__mono_pending_tx_browser_ops')")

                assert active_result == {"kind": "busy"}, active_result
                assert first_result == {"kind": "completed", "value": "simulated-local-operation"}, first_result
                assert pending_result["kind"] == "pending", pending_result
                assert pending_result["record"]["signature"] == "3" * 64, pending_result
                assert operation_count == "1", operation_count

                first.evaluate(
                    """({ owner, key }) => {
                      localStorage.removeItem(key);
                      localStorage.removeItem('__mono_pending_tx_browser_ops');
                    }""",
                    {"owner": OWNER, "key": PENDING_KEY},
                )
                print(json.dumps({
                    "status": "PASS",
                    "navigatorLocks": lock_api,
                    "whileFirstOperationHeld": active_result,
                    "firstOperation": first_result,
                    "afterPersistedSignature": {
                        "kind": pending_result["kind"],
                        "signature": pending_result["record"]["signature"],
                    },
                    "operationCount": operation_count,
                    "networkTransaction": "not initiated",
                }, indent=2))
                context.close()
            finally:
                browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
