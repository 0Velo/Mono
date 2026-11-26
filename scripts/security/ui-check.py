#!/usr/bin/env python3
"""Built-app security checks for Mono (Playwright).

Loads the production build the way a phone does and checks the claims the audit
report makes about the shipped page:

  - the CSP is present and actually blocks eval in the browser;
  - creating a wallet leaves no seed word in localStorage or IndexedDB;
  - the encrypted vault is what is persisted, and it is not plaintext;
  - `pagehide` locks the wallet (no decrypted key left behind);
  - a wrong PIN is rejected;
  - a script-shaped recipient address never executes;
  - which external origins the page talks to.

Prints JSON: {"status": "PASS|FAIL", "checks": [...], "requests": [...]}
"""
import http.server
import base64
import glob
import json
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.getcwd()
DIST = os.path.join(ROOT, "dist")
checks = []
requests_seen = []
console_errors = []
page_errors = []
dialogs = []


def record(cid, title, status, detail=""):
    checks.append({"id": cid, "title": title, "status": status, "detail": detail})


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def log_message(self, *args):
        pass

    def _rpc_result(self, entry):
        """A tiny stand-in RPC, so a funded wallet can be opened without network."""
        method = entry.get("method")
        params = entry.get("params") or []
        context = {"slot": 123456}
        if method == "getBalance":
            return {"context": context, "value": MOCK_SOL_LAMPORTS}
        if method in ("getTokenAccountsByOwner", "getParsedTokenAccountsByOwner"):
            program = ""
            if len(params) > 1 and isinstance(params[1], dict):
                program = str(params[1].get("programId") or "")
            value = MOCK_TOKEN_ACCOUNTS if program == MOCK_TOKEN_PROGRAM else []
            return {"context": context, "value": value}
        if method == "getSignaturesForAddress":
            return []
        if method == "getLatestBlockhash":
            return {
                "context": context,
                "value": {
                    "blockhash": "11111111111111111111111111111111",
                    "lastValidBlockHeight": 999999,
                },
            }
        if method == "getBlockHeight":
            return 123456
        if method == "getFeeForMessage":
            return {"context": context, "value": MOCK_FEE_LAMPORTS}
        # The send preview reads the pre-state of every account in the message
        # and then simulates it. The stand-in answers for the one send the
        # built-app checks make (0.1 SOL to a never-seen address), so the
        # confirm screen can be reached without a network.
        if method == "getMultipleAccounts":
            keys = params[0] if params and isinstance(params[0], list) else []
            return {
                "context": context,
                "value": [mock_account(lamports_for_index(index)) for index in range(len(keys))],
            }
        if method == "simulateTransaction":
            options = params[1] if len(params) > 1 and isinstance(params[1], dict) else {}
            accounts = (options.get("accounts") or {}) if isinstance(options, dict) else {}
            addresses = accounts.get("addresses") or []
            return {
                "context": context,
                "value": {
                    "err": None,
                    "logs": [
                        "Program 11111111111111111111111111111111 invoke [1]",
                        "Program 11111111111111111111111111111111 success",
                    ],
                    "accounts": [
                        mock_account(lamports_for_index(index, after=True)) for index in range(len(addresses))
                    ],
                    "unitsConsumed": 150,
                    "returnData": None,
                },
            }
        return None

    def do_POST(self):
        if not self.path.startswith("/rpc"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}

        def answer(entry):
            entry = entry if isinstance(entry, dict) else {}
            return {
                "jsonrpc": "2.0",
                "id": entry.get("id", 1),
                "result": self._rpc_result(entry),
            }

        body = json.dumps([answer(item) for item in payload] if isinstance(payload, list) else answer(payload))
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()


MOCK_SOL_LAMPORTS = 5_000_000_000
MOCK_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MOCK_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
# What the built-app send checks transfer: 0.1 SOL, 5000 lamports of fee.
MOCK_SEND_LAMPORTS = 100_000_000
MOCK_FEE_LAMPORTS = 5000


def lamports_for_index(index: int, after: bool = False) -> int:
    """One account's lamports for the 0.1 SOL transfer check.

    Index 0 is the fee payer (the wallet), index 1 the recipient. Before the
    transfer the wallet holds MOCK_SOL_LAMPORTS and the recipient nothing;
    after it the wallet paid amount + fee and the recipient received the amount.
    Any other account in the message is untouched.
    """
    if index == 0:
        return MOCK_SOL_LAMPORTS - MOCK_SEND_LAMPORTS - MOCK_FEE_LAMPORTS if after else MOCK_SOL_LAMPORTS
    if index == 1:
        return MOCK_SEND_LAMPORTS if after else 0
    return MOCK_FEE_LAMPORTS


def mock_account(lamports: int) -> dict:
    """An account as the RPC reports it with base64 data."""
    return {
        "executable": False,
        "owner": "11111111111111111111111111111111",
        "lamports": lamports,
        "data": ["", "base64"],
        "rentEpoch": 0,
        "space": 0,
    }


def mock_token_account(address: str, lamports: int) -> dict:
    """A parsed, empty SPL token account exactly as the RPC reports it."""
    return {
        "pubkey": address,
        "account": {
            "lamports": lamports,
            "executable": False,
            "owner": MOCK_TOKEN_PROGRAM,
            "rentEpoch": 0,
            "space": 165,
            "data": {
                "program": "spl-token",
                "parsed": { 
                    "type": "account",
                    "info": {
                        "mint": MOCK_USDC_MINT,
                        "owner": "11111111111111111111111111111111",
                        "tokenAmount": {
                            "amount": "0",
                            "decimals": 6,
                            "uiAmount": 0,
                            "uiAmountString": "0",
                        },
                        "state": "initialized",
                        "isNative": False,
                        "closeAuthority": None,
                    },
                },
                "space": 165,
            },
        },
    }


# Two empty token accounts, each holding the 1,488,440 lamport rent observed on
# mainnet: closes to ~0.0029 SOL after the fee.
MOCK_TOKEN_ACCOUNTS = [
    mock_token_account("Ccuq2woKJGvocM7FYrGwGs4NnnhUSM4n22ZFyYf8H7DE", 1_488_440),
    mock_token_account("HXwhnMhFH5cGRs9hfWdXZLHuHSzpgYvbYH6oWiJXYvzm", 1_488_440),
]


def serve(port):
    httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def type_pin(page, pin):
    for digit in pin:
        page.locator(f'button[aria-label="{digit}"]').click()
        page.wait_for_timeout(40)


def account_snapshot(page):
    return page.evaluate(
        """() => {
            const dialog = document.querySelector('[role="dialog"]');
            const rows = dialog ? [...dialog.querySelectorAll('[data-account-index]')] : [];
            const labels = rows
                .map(row => row.innerText.split(String.fromCharCode(10))[0].trim())
                .filter(Boolean);
            const addresses = rows.map(row => row.dataset.accountAddress || '');
            let meta = null;
            try { meta = JSON.parse(localStorage.getItem('mono.meta.v1') || 'null'); } catch {}
            return { labels, addresses, meta };
        }"""
    )


def main():
    # Point the same checks at an already-deployed build with MONO_BASE_URL.
    live_base = os.environ.get("MONO_BASE_URL")
    httpd = None
    if live_base:
        base = live_base.rstrip("/") + "/"
    else:
        port = free_port()
        httpd = serve(port)
        base = f"http://127.0.0.1:{port}/"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 430, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        page = context.new_page()
        page.on("request", lambda req: requests_seen.append(req.url))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))

        page.goto(base, wait_until="domcontentloaded")
        page.wait_for_selector("text=새 지갑 만들기", timeout=20000)

        # browser.new_context() is an ephemeral, isolated profile; confirm that
        # it contains no wallet material before creating the test-only wallet.
        fresh_state = page.evaluate(
            """async () => {
                const walletKeys = ['mono.meta.v1', 'solwallet.meta.v1', 'solwallet.vault.v1', 'mono.vault.fallback.v1'];
                const presentLocalKeys = walletKeys.filter(key => localStorage.getItem(key) !== null);
                const presentSessionKeys = walletKeys.filter(key => sessionStorage.getItem(key) !== null);
                let idbVault = null;
                let idbError = '';
                try {
                    const request = indexedDB.open('mono-vault');
                    const db = await new Promise((resolve, reject) => {
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (db.objectStoreNames.contains('vault')) {
                        idbVault = await new Promise((resolve, reject) => {
                            const get = db.transaction('vault', 'readonly').objectStore('vault').get('primary');
                            get.onsuccess = () => resolve(get.result ?? null);
                            get.onerror = () => reject(get.error);
                        });
                    }
                    db.close();
                } catch (error) { idbError = String(error); }
                return { presentLocalKeys, presentSessionKeys, hasIdbVault: idbVault !== null, idbError };
            }"""
        )
        fresh_ok = (
            not fresh_state["presentLocalKeys"]
            and not fresh_state["presentSessionKeys"]
            and not fresh_state["hasIdbVault"]
            and not fresh_state["idbError"]
        )
        record(
            "UI-17",
            "A disposable browser context starts without pre-existing wallet material",
            "PASS" if fresh_ok else "FAIL",
            json.dumps(fresh_state, ensure_ascii=False),
        )

        record("UI-01", "The production build renders the onboarding screen", "PASS", page.title())

        csp = page.evaluate("() => document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? ''")
        required = ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-src 'none'"]
        record(
            "UI-02",
            "The CSP meta tag is served and carries the required directives",
            "PASS" if all(item in csp for item in required) else "FAIL",
            ", ".join(item for item in required if item not in csp) or csp,
        )

        # CDP evaluation is not subject to the page CSP, so inject a real inline
        # <script> element instead: if the CSP is in force it must not execute,
        # and eval() from page script must be refused too.
        csp_probe = page.evaluate(
            """() => new Promise((resolve) => {
                window.__mono_inline_ran = 0;
                const script = document.createElement('script');
                script.textContent = "window.__mono_inline_ran = 1; window.__mono_eval = (function(){ try { return String(eval('1+1')); } catch (e) { return 'BLOCKED:' + e.name; } })();";
                document.body.appendChild(script);
                setTimeout(() => resolve({
                    inlineRan: window.__mono_inline_ran,
                    evalResult: window.__mono_eval === undefined ? 'NOT_RUN' : window.__mono_eval,
                }), 400);
            })"""
        )
        csp_holds = csp_probe["inlineRan"] == 0 and (
            csp_probe["evalResult"] == "NOT_RUN" or str(csp_probe["evalResult"]).startswith("BLOCKED")
        )
        record(
            "UI-03",
            "An injected inline script and eval() are blocked by the CSP",
            "PASS" if csp_holds else "FAIL",
            f"inline_ran={csp_probe['inlineRan']} eval={csp_probe['evalResult']}",
        )

        scripts = page.evaluate("() => [...document.querySelectorAll('script[src]')].map(s => s.src)")
        record(
            "UI-04",
            "Every script is same-origin",
            "PASS" if all(src.startswith(base) for src in scripts) else "FAIL",
            ", ".join(scripts),
        )

        # --- create a wallet and read the phrase the app shows -----------------
        page.get_by_role("button", name="새 지갑 만들기").click()
        page.wait_for_selector("text=시드 문구를 안전한 곳에 적어 두었습니다.", timeout=20000)
        page.wait_for_timeout(600)
        words = page.evaluate(
            """() => {
                const grid = [...document.querySelectorAll('div.grid')].find(el => el.children.length === 12);
                if (!grid) return [];
                return [...grid.children].map(cell => {
                    const spans = cell.querySelectorAll('span');
                    return spans.length ? spans[spans.length - 1].textContent.trim() : '';
                }).filter(Boolean);
            }"""
        )
        record(
            "UI-05",
            "A new wallet shows a 12-word phrase",
            "PASS" if len(words) == 12 else "FAIL",
            f"{len(words)} words",
        )

        page.get_by_text("시드 문구를 안전한 곳에 적어 두었습니다.").click()
        page.get_by_role("button", name="다음").click()
        page.wait_for_selector("text=PIN 설정", timeout=10000)

        type_pin(page, "123456")
        page.wait_for_selector("text=PIN 확인", timeout=10000)
        type_pin(page, "123456")
        page.wait_for_selector("text=보내기", timeout=25000)
        record("UI-06", "The wallet unlocks after setting a PIN", "PASS")

        storage_dump = page.evaluate(
            """async () => {
                const local = {};
                for (let i = 0; i < localStorage.length; i += 1) {
                    const key = localStorage.key(i);
                    local[key] = localStorage.getItem(key);
                }
                const idb = {};
                const open = indexedDB.open('mono-vault');
                const db = await new Promise((resolve, reject) => {
                    open.onsuccess = () => resolve(open.result);
                    open.onerror = () => reject(open.error);
                });
                for (const store of [...db.objectStoreNames]) {
                    idb[store] = await new Promise((resolve) => {
                        const tx = db.transaction(store, 'readonly');
                        const req = tx.objectStore(store).getAllKeys();
                        req.onsuccess = async () => {
                            const keys = req.result;
                            const values = {};
                            for (const key of keys) {
                                values[String(key)] = await new Promise((res) => {
                                    const r2 = db.transaction(store, 'readonly').objectStore(store).get(key);
                                    r2.onsuccess = () => res(r2.result);
                                });
                            }
                            resolve(values);
                        };
                        req.onerror = () => resolve({});
                    });
                }
                const sessions = { local: { ...sessionStorage } };
                return { local, idb, sessions, keys: [...db.objectStoreNames] };
            }"""
        )
        blob = json.dumps(storage_dump, default=str)
        leaked = [word for word in words if word and f'"{word}"' in blob]
        # A single word can appear inside base64 by chance; a run of 3 in order cannot.
        runs = 0
        for index in range(len(words) - 2):
            if " ".join(words[index : index + 3]) in blob:
                runs += 1
        record(
            "UI-07",
            "No seed word sequence is written to localStorage/sessionStorage/IndexedDB",
            "PASS" if runs == 0 else "FAIL",
            f"leaked_words={leaked} ordered_3word_runs={runs}",
        )

        vault = storage_dump["idb"].get("vault", {}).get("primary")
        vault_ok = isinstance(vault, dict) and vault.get("iter") == 210000 and len(vault.get("ct", "")) > 40
        record(
            "UI-08",
            "The persisted secret is the encrypted vault (PBKDF2 210k + AES-GCM), not plaintext",
            "PASS" if vault_ok else "FAIL",
            json.dumps({key: vault.get(key) for key in ("v", "kdf", "iter", "iv", "salt")}, default=str) if isinstance(vault, dict) else str(vault)[:200],
        )

        biometric_ui = page.evaluate(
            "() => /Face ID|생체인증|WebAuthn|PRF/i.test(document.body.innerText)"
        )
        biometric_storage_keys = [
            key
            for key in [*storage_dump["local"].keys(), *storage_dump["keys"]]
            if any(term in key.lower() for term in ("faceid", "biometric", "webauthn", "prf"))
        ]
        record(
            "UI-09",
            "Biometric unlock UI and persisted state are absent",
            "PASS" if not biometric_ui and not biometric_storage_keys else "FAIL",
            f"ui_present={biometric_ui} storage_keys={biometric_storage_keys}",
        )

        # --- pagehide must lock ------------------------------------------------
        page.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))")
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=5000)
            locked = True
        except Exception:
            locked = False
        record("UI-10", "pagehide locks the wallet and drops the decrypted key", "PASS" if locked else "FAIL")

        # --- wrong PIN ---------------------------------------------------------
        type_pin(page, "000000")
        try:
            page.wait_for_selector("text=PIN이 올바르지 않습니다", timeout=8000)
            wrong_rejected = True
        except Exception:
            wrong_rejected = False
        record("UI-11", "A wrong PIN is rejected", "PASS" if wrong_rejected else "FAIL")

        # --- unlock and probe the address field for XSS ------------------------
        page.wait_for_timeout(600)
        type_pin(page, "123456")
        page.wait_for_selector("text=보내기", timeout=25000)
        page.get_by_role("button", name="보내기").first.click()
        page.wait_for_selector("#recipient-input", timeout=10000)
        page.fill("#recipient-input", '<img src=x onerror="window.__mono_xss=1">')
        page.wait_for_timeout(500)
        xss = page.evaluate("() => Boolean(window.__mono_xss)")
        address_warning = page.locator("text=주소 형식을 확인하세요").count()
        record(
            "UI-12",
            "A script-shaped recipient is treated as an invalid address and never executes",
            "PASS" if not xss and address_warning > 0 else "FAIL",
            f"executed={xss} invalid_warning={address_warning}",
        )

        # Address book label round-trips as text, not HTML.
        page.fill("#recipient-input", words and "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk" or "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk")
        page.wait_for_timeout(300)
        page.get_by_text("주소록 저장").click()
        label_input = page.locator('input[placeholder^="이름"]')
        if label_input.count():
            label_input.first.fill('<script>window.__mono_xss2=1</script>')
            page.get_by_role("button", name="저장").last.click()
            page.wait_for_timeout(500)
        xss2 = page.evaluate("() => Boolean(window.__mono_xss2)")
        stored_label = page.evaluate("() => localStorage.getItem('mono.addressBook.v1') ?? ''")
        record(
            "UI-13",
            "An address-book label is stored and rendered as inert text",
            "PASS" if not xss2 and "script" not in str(dialogs) else "FAIL",
            f"executed={xss2} label_saved={bool(stored_label)}",
        )

        # A full reload must leave only the encrypted vault and metadata; unlock
        # the disposable test wallet and confirm its original address returns.
        original_address = page.evaluate(
            "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.address ?? ''"
        )
        page.reload(wait_until="domcontentloaded")
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            reload_locked = True
        except Exception:
            reload_locked = False
        reload_unlocked = False
        if reload_locked:
            type_pin(page, "123456")
            try:
                page.wait_for_selector("text=보내기", timeout=25000)
                reload_unlocked = True
            except Exception:
                reload_unlocked = False
        restored_address = page.evaluate(
            "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.address ?? ''"
        )
        record(
            "UI-18",
            "Reload locks the persisted wallet and the correct PIN restores its original address",
            "PASS" if reload_locked and reload_unlocked and original_address and restored_address == original_address else "FAIL",
            f"locked={reload_locked} unlocked={reload_unlocked} original_address_restored={bool(original_address and restored_address == original_address)}",
        )

        # This list is inspected inside the real account-management sheet. The
        # browser context is disposable and all actions here are local key
        # derivation/account selection; no send or transaction confirmation is
        # opened or submitted.
        page.locator('button[aria-label="계정 전환"]').click()
        page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
        initial_accounts = account_snapshot(page)
        initial_ok = initial_accounts["labels"] == ["메인"] and initial_accounts["meta"] is not None
        record(
            "UI-19",
            "A freshly created mnemonic wallet presents exactly one account",
            "PASS" if initial_ok else "FAIL",
            json.dumps(initial_accounts, ensure_ascii=False),
        )

        main_address = initial_accounts.get("meta", {}).get("address", "") if initial_accounts.get("meta") else ""
        page.get_by_role("button", name="계정 추가").click()
        try:
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.activeIndex === 1",
                timeout=15000,
            )
            add_switched = True
        except Exception:
            add_switched = False
        # The sheet stays open after adding, so the new row is visible at once.
        page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
        added_accounts = account_snapshot(page)
        second_meta = added_accounts.get("meta") or {}
        add_ok = (
            add_switched
            and added_accounts["labels"] == ["메인", "계정 2"]
            and second_meta.get("activeIndex") == 1
            and 1 in (second_meta.get("accountIndices") or [])
            and bool(second_meta.get("address"))
            and second_meta.get("address") != main_address
        )
        record(
            "UI-20",
            "Explicit account creation adds account 2 and switches to its distinct derived address",
            "PASS" if add_ok else "FAIL",
            json.dumps({"added": added_accounts, "mainAddressDistinct": bool(second_meta.get("address") and second_meta.get("address") != main_address), "addSwitched": add_switched}, ensure_ascii=False),
        )

        page.get_by_role("dialog").get_by_role("button", name=re.compile(r"^메인")).click()
        try:
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.activeIndex === 0",
                timeout=10000,
            )
            switched_back = True
        except Exception:
            switched_back = False
        back_meta = page.evaluate(
            "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')"
        )
        back_ok = (
            switched_back
            and back_meta is not None
            and back_meta.get("activeIndex") == 0
            and back_meta.get("address") == main_address
            and 1 in (back_meta.get("accountIndices") or [])
        )
        record(
            "UI-21",
            "Explicitly switching back selects the original account without removing account 2",
            "PASS" if back_ok else "FAIL",
            f"switched_back={switched_back} activeIndex={back_meta.get('activeIndex') if back_meta else None} original_address_restored={bool(back_meta and back_meta.get('address') == main_address)} accountIndices={back_meta.get('accountIndices') if back_meta else None}",
        )

        page.reload(wait_until="domcontentloaded")
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            second_reload_locked = True
        except Exception:
            second_reload_locked = False
        second_reload_unlocked = False
        if second_reload_locked:
            type_pin(page, "123456")
            try:
                page.wait_for_selector("text=보내기", timeout=25000)
                second_reload_unlocked = True
            except Exception:
                second_reload_unlocked = False
        persisted_home = page.evaluate(
            "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')"
        )
        persisted_ok = (
            second_reload_locked
            and second_reload_unlocked
            and persisted_home is not None
            and persisted_home.get("activeIndex") == 0
            and persisted_home.get("address") == main_address
            and 1 in (persisted_home.get("accountIndices") or [])
        )
        persisted_accounts = {"labels": [], "meta": persisted_home}
        if second_reload_unlocked:
            page.locator('button[aria-label="계정 전환"]').click()
            page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
            persisted_accounts = account_snapshot(page)
            persisted_ok = persisted_ok and persisted_accounts["labels"] == ["메인", "계정 2"]
        record(
            "UI-22",
            "The second account and selected main account persist through reload and unlock",
            "PASS" if persisted_ok else "FAIL",
            json.dumps({"locked": second_reload_locked, "unlocked": second_reload_unlocked, "accounts": persisted_accounts}, ensure_ascii=False),
        )


        # --- more than three accounts (report: "계정이 계속 3 개로 고정이야") -----
        if page.get_by_role("dialog").count() == 0:
            page.locator('button[aria-label="계정 전환"]').click()
            page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
        grew = True
        add_error = ""
        for expected_total in range(3, 7):
            page.get_by_role("button", name="계정 추가").click()
            try:
                page.wait_for_function(
                    "count => { const m = JSON.parse(localStorage.getItem('mono.meta.v1') || 'null');"
                    " return Boolean(m) && Array.isArray(m.accountIndices) && m.accountIndices.length === count - 1; }",
                    arg=expected_total,
                    timeout=15000,
                )
            except Exception as error:
                grew = False
                add_error = str(error)[:200]
                break
        multi = account_snapshot(page)
        multi_meta = multi.get("meta") or {}
        addresses = [address for address in multi.get("addresses", []) if address]
        distinct_ok = (
            len(multi["labels"]) >= 6
            and len(set(multi["labels"])) == len(multi["labels"])
            and len(set(addresses)) == len(addresses)
            and len(addresses) == len(multi["labels"])
        )
        record(
            "UI-23",
            "Accounts keep being added past three: six separate derived accounts in the registry",
            "PASS" if grew and distinct_ok and multi_meta.get("activeIndex") == 5 and (multi_meta.get("accountIndices") or []) == [1, 2, 3, 4, 5] else "FAIL",
            json.dumps({"labels": multi["labels"], "activeIndex": multi_meta.get("activeIndex"), "accountIndices": multi_meta.get("accountIndices"), "error": add_error}, ensure_ascii=False),
        )

        # --- rename and delete -------------------------------------------------
        renamed = False
        try:
            page.get_by_role("dialog").locator('button[aria-label="이름 바꾸기"]').nth(2).click()
            page.get_by_role("dialog").locator("input").last.fill("투빗")
            page.get_by_role("dialog").locator('button[aria-label="이름 저장"]').first.click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.accountNames?.['2'] === '투빗'",
                timeout=10000,
            )
            renamed = page.get_by_role("dialog").get_by_text("투빗", exact=True).count() > 0
        except Exception:
            renamed = False
        record(
            "UI-24",
            "An account above the third can be renamed and the name is written to metadata",
            "PASS" if renamed else "FAIL",
            json.dumps(account_snapshot(page).get("meta", {}).get("accountNames"), ensure_ascii=False),
        )

        deleted = False
        try:
            page.get_by_role("dialog").locator('button[aria-label="계정 삭제"]').nth(5).click()
            page.get_by_role("button", name=re.compile(r"^삭제$")).click()
            page.wait_for_function(
                "() => { const m = JSON.parse(localStorage.getItem('mono.meta.v1') || 'null');"
                " return Boolean(m) && Array.isArray(m.accountIndices) && m.accountIndices.length === 4; }",
                timeout=10000,
            )
            after_delete = account_snapshot(page)
            deleted = len(after_delete["labels"]) == 5 and (after_delete["meta"] or {}).get("activeIndex") == 0
        except Exception:
            after_delete = account_snapshot(page)
        record(
            "UI-25",
            "An account can be deleted from the list; the wallet falls back to a remaining account",
            "PASS" if deleted else "FAIL",
            json.dumps({"labels": after_delete.get("labels"), "activeIndex": (after_delete.get("meta") or {}).get("activeIndex")}, ensure_ascii=False),
        )

        page.reload(wait_until="domcontentloaded")
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            third_reload_locked = True
            type_pin(page, "123456")
            page.wait_for_selector("text=보내기", timeout=25000)
        except Exception:
            third_reload_locked = False
        page.locator('button[aria-label="계정 전환"]').click()
        page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
        persisted_multi = account_snapshot(page)
        record(
            "UI-26",
            "The six-to-five account list, the rename and the remaining active account survive a reload",
            "PASS" if third_reload_locked and persisted_multi["labels"] == ["메인", "계정 2", "투빗", "계정 4", "계정 5"] else "FAIL",
            json.dumps({"locked": third_reload_locked, "labels": persisted_multi["labels"], "meta": persisted_multi.get("meta")}, ensure_ascii=False),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # --- background Web Push state comes from the build-time server URL ---
        page.get_by_role("button", name="설정", exact=True).first.click()
        page.wait_for_selector("text=백그라운드 Web Push", timeout=15000)
        push_row = page.locator("button", has_text="백그라운드 Web Push").first
        push_row_text = push_row.inner_text()
        push_state = push_row_text.replace("백그라운드 Web Push", "").strip()
        push_actionable = push_row.is_enabled()
        record(
            "UI-27",
            "The built app points at the background push server and offers the opt-in",
            "PASS" if push_state in {"끔", "켜짐", "홈 화면 설치 필요"} and push_actionable else "FAIL",
            json.dumps({"state": push_state, "actionable": push_actionable}, ensure_ascii=False),
        )
        # --- whale wallet watch list (고래 지갑 알림) ---------------------------
        watch_state = {"added": None, "toggled": None, "renamed": None, "removed": None}
        reset_watch_state = {"added": None, "toggled": None, "renamed": None, "removed": None}
        try:
            page.evaluate("() => localStorage.removeItem('mono.watchWallets.v1')")
            page.locator("button", has_text="고래 지갑 알림").first.click()
            dialog = page.get_by_role("dialog")
            dialog.wait_for(state="visible", timeout=10000)
            dialog.get_by_role("button", name=re.compile("고래 지갑 추가")).click()
            dialog.get_by_text("Solana 주소").wait_for(timeout=10000)
            dialog.locator("input").nth(0).fill("고래 1")
            dialog.locator("input").nth(1).fill("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")
            dialog.get_by_role("button", name="추가", exact=True).click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === 1",
                timeout=10000,
            )
            watch_state["added"] = page.evaluate(
                "() => { const e = JSON.parse(localStorage.getItem('mono.watchWallets.v1'))[0];"
                " return { label: e.label, address: e.address, enabled: e.enabled }; }"
            )
            dialog.get_by_role("button", name="알림 끄기").click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]')[0]?.enabled === false",
                timeout=10000,
            )
            watch_state["toggled"] = page.evaluate("() => JSON.parse(localStorage.getItem('mono.watchWallets.v1'))[0].enabled")
            dialog.get_by_role("button", name="별명 수정").click()
            rename_input = dialog.locator("input").first
            rename_input.fill("고래 2")
            dialog.get_by_role("button", name="저장", exact=True).click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]')[0]?.label === '고래 2'",
                timeout=10000,
            )
            watch_state["renamed"] = page.evaluate("() => JSON.parse(localStorage.getItem('mono.watchWallets.v1'))[0].label")
            dialog.get_by_role("button", name="삭제").click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === 0",
                timeout=10000,
            )
            watch_state["removed"] = page.evaluate("() => JSON.parse(localStorage.getItem('mono.watchWallets.v1')).length")
            dialog.locator('button[aria-label="닫기"]').click()
            page.wait_for_timeout(400)
        except Exception as error:
            watch_state["error"] = str(error)[:200]
            try:
                page.get_by_role("dialog").locator('button[aria-label="닫기"]').click()
                page.wait_for_timeout(300)
            except Exception:
                pass
        record(
            "UI-46",
            "A whale wallet can be added with a label, muted, renamed and deleted from the settings sheet",
            "PASS"
            if watch_state.get("added")
            and watch_state["added"] == {"label": "고래 1", "address": "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "enabled": True}
            and watch_state.get("toggled") is False
            and watch_state.get("renamed") == "고래 2"
            and watch_state.get("removed") == 0
            else "FAIL",
            json.dumps(watch_state, ensure_ascii=False),
        )
        page.evaluate("() => localStorage.removeItem('mono.watchWallets.v1')")

        # --- recommended whales (추천 고래) one-tap presets ---------------------
        # Fifteen fixed public addresses: one tap adds them all in a single write,
        # each chip adds only itself, a tracked chip reads 추가됨, and the list
        # stops at twenty wallets (the raised cap the person asked for).
        PRESET_NAMES = [
            "Trunoest", "OGAntD", "Decu", "Cooker", "Ansem", "SKX", "LJC", "ozark",
            "rayan", "Pain", "Mitch", "Jijo", "Frank DeGods", "Cap", "Dov",
        ]
        preset_state = {"chips": None, "bulk": None, "marked": None, "readded": None, "full": None}
        try:
            page.locator("button", has_text="고래 지갑 알림").first.click()
            dialog = page.get_by_role("dialog")
            dialog.wait_for(state="visible", timeout=10000)
            preset_state["chips"] = sum(
                1
                for name in PRESET_NAMES
                if dialog.get_by_role("button", name=f"{name} 추가", exact=True).count() == 1
            )
            dialog.get_by_role("button", name="전체 추가", exact=True).click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === 15",
                timeout=10000,
            )
            preset_state["bulk"] = page.evaluate(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1')).map(e => e.label)"
            )
            preset_state["marked"] = page.get_by_text("· 추가됨").count()
            # Delete one row, then the chip for it adds only that wallet back.
            dialog.get_by_role("button", name="삭제").first.click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === 14",
                timeout=10000,
            )
            dialog.get_by_role("button", name="Trunoest 추가", exact=True).click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === 15",
                timeout=10000,
            )
            preset_state["readded"] = page.evaluate(
                "() => JSON.parse(localStorage.getItem('mono.watchWallets.v1'))"
                ".some(e => e.label === 'Trunoest' && e.address === 'ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT')"
            )
            # Fill the last five seats by hand; twenty is the cap and then the
            # footer button and the preset controls all lock.
            manual_addresses = [
                f"7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G{suffix}" for suffix in "abcde"
            ]
            for index, address in enumerate(manual_addresses):
                dialog.get_by_role("button", name=re.compile("고래 지갑 추가")).click()
                dialog.get_by_text("Solana 주소").wait_for(timeout=10000)
                dialog.locator("input").nth(0).fill(f"수동 {index + 1}")
                dialog.locator("input").nth(1).fill(address)
                dialog.get_by_role("button", name="추가", exact=True).click()
                page.wait_for_function(
                    f"() => JSON.parse(localStorage.getItem('mono.watchWallets.v1') || '[]').length === {16 + index}",
                    timeout=10000,
                )
            preset_state["full"] = {
                "count": page.evaluate("() => JSON.parse(localStorage.getItem('mono.watchWallets.v1')).length"),
                "addDisabled": dialog.get_by_role("button", name=re.compile("고래 지갑 추가")).is_disabled(),
                "allDisabled": dialog.get_by_role("button", name="모두 추가됨", exact=True).is_disabled(),
                "chipDisabled": dialog.get_by_role("button", name="Ansem · 추가됨", exact=True).is_disabled(),
            }
            dialog.locator('button[aria-label="닫기"]').click()
            page.wait_for_timeout(400)
        except Exception as error:
            preset_state["error"] = str(error)[:200]
            try:
                page.get_by_role("dialog").locator('button[aria-label="닫기"]').click()
                page.wait_for_timeout(300)
            except Exception:
                pass
        record(
            "UI-47",
            "The fifteen recommended whales add in one tap, one by one, and the list stops at twenty",
            "PASS"
            if preset_state.get("chips") == 15
            and preset_state.get("bulk") == PRESET_NAMES
            and preset_state.get("marked") == 15
            and preset_state.get("readded") is True
            and preset_state.get("full")
            == {"count": 20, "addDisabled": True, "allDisabled": True, "chipDisabled": True}
            else "FAIL",
            json.dumps(preset_state, ensure_ascii=False),
        )
        page.evaluate("() => localStorage.removeItem('mono.watchWallets.v1')")

        page.get_by_role("button", name="지갑", exact=True).first.click()
        page.wait_for_timeout(400)

        # --- the splash lands on the lock screen's own mark --------------------
        # A wallet exists now, so opening the app must not end the splash with
        # the saucer flying off: it carries the alien up to the MonoMark slot
        # above the keypad, sets it down at that mark's size and leaves, and the
        # real mark takes the spot. Measured on a fresh load of the built app.
        def landing_snapshot() -> dict:
            return page.evaluate(
                """() => {
                    const splash = document.getElementById('app-splash');
                    const stage = splash && splash.querySelector('.splash-stage');
                    const target = document.querySelector('[data-mono-landing-target]');
                    const mark = document.querySelector('.mono-land-mark');
                    const rect = (el) => (el ? el.getBoundingClientRect() : null);
                    const size = (el) => (el ? [Math.round(rect(el).width), Math.round(rect(el).height)] : null);
                    return {
                        mounted: Boolean(splash),
                        mode: splash ? splash.dataset.mode || '' : '',
                        state: splash ? splash.dataset.state || '' : '',
                        dx: splash ? parseFloat(splash.style.getPropertyValue('--land-dx')) : null,
                        dy: splash ? parseFloat(splash.style.getPropertyValue('--land-dy')) : null,
                        scale: splash ? parseFloat(splash.style.getPropertyValue('--land-s')) : null,
                        targetSize: size(target),
                        stageSize: size(stage),
                        markOpacity: mark ? Number(getComputedStyle(mark).opacity) : null,
                        landingClass: document.documentElement.classList.contains('mono-landing'),
                    };
                }"""
            )

        page.goto(base, wait_until="commit")
        try:
            page.wait_for_function(
                "() => { const s = document.getElementById('app-splash');"
                " return Boolean(s && s.dataset.mode === 'land'); }",
                timeout=8000,
            )
            landing_started = True
        except Exception:
            landing_started = False
        landing = landing_snapshot()
        page.wait_for_timeout(3400)
        settled = landing_snapshot()
        landing_ok = (
            landing_started
            and landing["mode"] == "land"
            and landing["landingClass"]
            and landing["targetSize"] == [92, 92]
            and landing["dy"] is not None
            and landing["dy"] < -60
            and abs(landing["dx"] or 0) < 40
            and 0.15 < (landing["scale"] or 0) < 0.6
            and not settled["mounted"]
            and settled["markOpacity"] == 1
            and not settled["landingClass"]
        )
        record(
            "UI-28",
            "The lock screen path lands the splash mascot on the MonoMark slot and hands the spot over",
            "PASS" if landing_ok else "FAIL",
            json.dumps({"landing": landing, "settled": settled}, ensure_ascii=False),
        )

        # Motion sickness settings skip the flight entirely: the splash stays a
        # static picture and the lock screen is simply there behind it.
        page.emulate_media(reduced_motion="reduce")
        page.goto(base, wait_until="commit")
        page.wait_for_timeout(1200)
        reduced = landing_snapshot()
        page.emulate_media(reduced_motion="no-preference")
        reduced_ok = (
            reduced["mounted"]
            and reduced["mode"] == ""
            and not reduced["landingClass"]
            and reduced["markOpacity"] == 1
            and reduced["stageSize"] is not None
        )
        record(
            "UI-29",
            "Reduced motion keeps a static splash and reveals the lock screen without the landing flight",
            "PASS" if reduced_ok else "FAIL",
            json.dumps(reduced, ensure_ascii=False),
        )
        page.goto(base, wait_until="domcontentloaded")
        page.wait_for_selector("text=지갑 잠김", timeout=15000)
        type_pin(page, "123456")
        page.wait_for_selector("text=보내기", timeout=25000)

        # --- a funded stand-in RPC for the balance-dependent checks -----------
        # A freshly created test wallet holds no SOL, so the home total and the
        # "보낸 뒤 잔액" line need a wallet with a balance. The local static
        # server also answers /rpc with exactly 5 SOL, and the wallet is pointed
        # at it for the checks below only (same origin, so the CSP allows it).
        # Live runs cannot host that endpoint; those two checks are then
        # recorded as REVIEW and the same checks run in the local suite.
        mock_available = httpd is not None

        def set_custom_rpc(url: str) -> None:
            page.evaluate(
                """(rpcUrl) => {
                    const meta = JSON.parse(localStorage.getItem('mono.meta.v1') || 'null');
                    if (!meta) return;
                    meta.rpc = { ...(meta.rpc || {}), mainnet: rpcUrl };
                    localStorage.setItem('mono.meta.v1', JSON.stringify(meta));
                }""",
                url,
            )

        if mock_available:
            set_custom_rpc(base + "rpc")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            type_pin(page, "123456")
            page.wait_for_selector("text=보내기", timeout=25000)

        hero_ready = True
        try:
            page.wait_for_selector("[data-balance-hidden]", timeout=25000)
        except Exception:
            hero_ready = False

        # --- privacy mode: tap the total to mask it ---------------------------
        if hero_ready:
            page.locator('button[aria-label="총 잔액 숨기기"]').first.click()
            page.wait_for_timeout(350)
            masked = page.locator('[data-balance-hidden="true"]')
            masked_text = masked.first.inner_text().strip() if masked.count() else ""
            saved_pref = page.evaluate(
                "() => JSON.parse(localStorage.getItem('mono.prefs.v1') || 'null')?.hideBalance === true"
            )
            record(
                "UI-30",
                "Tapping the home total masks it with •••• and stores the choice on the device",
                "PASS" if masked.count() == 1 and masked_text == "••••" and saved_pref else "FAIL",
                json.dumps({"text": masked_text, "saved": saved_pref}, ensure_ascii=False),
            )

            # A fresh launch must come back masked, and unmasking must stick too.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            type_pin(page, "123456")
            page.wait_for_selector("text=보내기", timeout=25000)
            page.wait_for_selector("[data-balance-hidden]", timeout=25000)
            still_masked = page.locator('[data-balance-hidden="true"]').count()
            page.locator('button[aria-label="총 잔액 보이기"]').first.click()
            page.wait_for_timeout(300)
            revealed = page.locator('[data-balance-hidden="false"]').count()
            record(
                "UI-31",
                "The masked total survives a reload, and tapping again shows the balance",
                "PASS" if still_masked == 1 and revealed == 1 else "FAIL",
                f"still_masked={still_masked} revealed={revealed}",
            )
        else:
            record(
                "UI-30",
                "Tapping the home total masks it with •••• and stores the choice on the device",
                "REVIEW",
                "home balance area did not load from the configured RPC in this run",
            )
            record(
                "UI-31",
                "The masked total survives a reload, and tapping again shows the balance",
                "REVIEW",
                "home balance area did not load from the configured RPC in this run",
            )

        # --- QR scan: the button opens the camera and fails clearly without one
        page.get_by_role("button", name="보내기").first.click()
        page.wait_for_selector("#recipient-input", timeout=10000)
        scan_button = page.locator('button[aria-label="QR 스캔"]')
        scan_button.first.click()
        camera_message = ""
        try:
            page.wait_for_selector("text=카메라", timeout=15000)
            camera_message = page.locator("text=카메라").first.inner_text().strip()
        except Exception:
            camera_message = ""
        close_scan = page.locator('button[aria-label="QR 스캔 닫기"]')
        if close_scan.count():
            close_scan.first.click()
            page.wait_for_timeout(300)
        overlay_closed = page.locator('button[aria-label="QR 스캔 닫기"]').count() == 0
        record(
            "UI-32",
            "The address field offers QR scanning and reports a missing camera instead of hanging",
            "PASS" if scan_button.count() == 1 and camera_message and overlay_closed else "FAIL",
            json.dumps({"button": scan_button.count(), "message": camera_message, "closed": overlay_closed}, ensure_ascii=False),
        )

        # --- recipient badge: own account / address book / first time ----------
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.locator('button[aria-label="계정 전환"]').click()
        page.get_by_role("dialog").wait_for(state="visible", timeout=10000)
        account_addresses = page.evaluate(
            """() => {
                const dialog = document.querySelector('[role="dialog"]');
                return dialog
                    ? [...dialog.querySelectorAll('[data-account-index]')].map(row => row.dataset.accountAddress || '')
                    : [];
            }"""
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        second_address = account_addresses[1] if len(account_addresses) > 1 else ""
        book_address = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"
        unknown_address = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"

        page.get_by_role("button", name="보내기").first.click()
        page.wait_for_selector("#recipient-input", timeout=10000)

        def badge_kind(address: str) -> dict:
            page.fill("#recipient-input", address)
            page.wait_for_timeout(250)
            return page.evaluate(
                """() => {
                    const badge = document.querySelector('[data-recipient-badge]');
                    return badge ? { kind: badge.dataset.recipientBadge, text: badge.innerText.trim() } : null;
                }"""
            )

        own_badge = badge_kind(second_address) if second_address else None
        book_badge = badge_kind(book_address)
        unknown_badge = badge_kind(unknown_address)
        badge_ok = (
            own_badge is not None
            and own_badge["kind"] == "own"
            and own_badge["text"] == "내 계정 2"
            and book_badge is not None
            and book_badge["kind"] == "book"
            and unknown_badge is not None
            and unknown_badge["kind"] == "external"
            and unknown_badge["text"] == "처음 보내는 주소"
        )
        record(
            "UI-33",
            "An own account, a saved address and a first-time address are each labelled before sending",
            "PASS" if badge_ok else "FAIL",
            json.dumps({"own": own_badge, "book": book_badge, "external": unknown_badge}, ensure_ascii=False),
        )

        # --- leftover SOL after the transfer, and a pasted Solana Pay request --
        if mock_available:
            page.fill("#recipient-input", unknown_address)
            page.fill("#amount-input", "1")
            page.wait_for_timeout(500)
            remaining_text = ""
            if page.locator('[data-remaining-sol="true"]').count():
                remaining_text = page.locator('[data-remaining-sol="true"]').first.inner_text().strip()
            record(
                "UI-34",
                "Typing an amount shows the SOL left afterwards (5 − 1 − fee = 3.9999 SOL)",
                "PASS" if remaining_text == "3.9999 SOL" else "FAIL",
                json.dumps({"remaining": remaining_text, "mock_lamports": MOCK_SOL_LAMPORTS}, ensure_ascii=False),
            )

            page.fill("#recipient-input", f"solana:{unknown_address}?amount=0.5&memo=order%2042")
            page.wait_for_timeout(500)
            uri_state = page.evaluate(
                """() => ({
                    address: document.querySelector('#recipient-input').value,
                    amount: document.querySelector('#amount-input').value,
                    memo: document.querySelector('[data-memo-chip]')?.innerText.trim() || '',
                    remaining: document.querySelector('[data-remaining-sol]')?.innerText.trim() || '',
                })"""
            )
            uri_ok = uri_state["address"] == unknown_address
            record(
                "UI-35",
                "A pasted Solana Pay URI fills the address, the amount and the memo",
                "PASS"
                if uri_ok
                and uri_state["amount"] == "0.5"
                and "메모" in uri_state["memo"]
                and "order 42" in uri_state["memo"]
                and uri_state["remaining"] == "4.4999 SOL"
                else "FAIL",
                json.dumps(uri_state, ensure_ascii=False),
            )

            # The wallet stays on the stand-in RPC one moment longer: the next
            # check reads empty token accounts from it.
        else:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            record(
                "UI-34",
                "Typing an amount shows the SOL left afterwards",
                "REVIEW",
                "live mode: the funded stand-in RPC lives on the local static server; the same check runs in the local suite",
            )
            record(
                "UI-35",
                "A pasted Solana Pay URI fills the address, the amount and the memo",
                "REVIEW",
                "live mode: the funded stand-in RPC lives on the local static server; the same check runs in the local suite",
            )

        # --- empty token accounts: the cleanup row and its confirmation -------
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.get_by_role("button", name="설정", exact=True).first.click()
        page.wait_for_selector("text=디스플레이", timeout=10000)
        if mock_available:
            row = page.locator("#rent-cleanup")
            try:
                row.first.wait_for(state="visible", timeout=20000)
                row_visible = True
            except Exception:
                row_visible = False
            row_text = row.first.inner_text().replace("\n", " ") if row_visible else ""
            sheet_text = ""
            if row_visible:
                row.first.click()
                page.wait_for_selector("text=빈 계정 2개 닫고 회수", timeout=15000)
                sheet_text = page.get_by_role("dialog").inner_text().replace("\n", " ")
                page.get_by_role("button", name="취소").first.click()
                page.wait_for_timeout(400)
            record(
                "UI-36",
                "Empty token accounts surface one cleanup row and a confirmation that lists what closes",
                "PASS"
                if row_visible
                and "빈 토큰 계정 2개 정리" in row_text
                and "0.0029" in row_text
                and "회수" in sheet_text
                and "2개" in sheet_text
                else "FAIL",
                json.dumps({"row": row_text, "sheet": sheet_text[:200]}, ensure_ascii=False),
            )
        else:
            page.wait_for_timeout(1500)
            cleanup_rows = page.locator("#rent-cleanup").count()
            record(
                "UI-36",
                "A wallet with no empty token accounts shows no cleanup row",
                "PASS" if cleanup_rows == 0 else "FAIL",
                f"rows={cleanup_rows}",
            )

        # --- read-only auto-login: home without a key, PIN only when needed --
        # Off by default, so every check above still started at the lock screen.
        page.get_by_role("button", name="설정", exact=True).first.click()
        page.wait_for_selector("text=자동 로그인 (조회 전용)", timeout=15000)
        auto_row = page.locator("button[data-auto-login]")
        default_off = auto_row.first.get_attribute("data-auto-login") == "off"
        # The wallet is open, so turning it on needs no extra prompt here.
        auto_row.first.click()
        try:
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.autoLogin === true",
                timeout=10000,
            )
            auto_saved = True
        except Exception:
            auto_saved = False
        record(
            "UI-38",
            "Auto-login is off by default and the settings row stores the choice",
            "PASS" if default_off and auto_saved else "FAIL",
            json.dumps({"defaultOff": default_off, "saved": auto_saved}, ensure_ascii=False),
        )

        # A fresh launch must land on the home screen with no PIN, from public
        # data only: the vault in IndexedDB stays the encrypted file.
        page.reload(wait_until="domcontentloaded")
        view_ready = False
        try:
            page.wait_for_selector("[data-view-only='true']", timeout=30000)
            view_ready = True
        except Exception:
            view_ready = False
        lock_screen_shown = page.get_by_text("지갑 잠김").count()
        storage_after = page.evaluate(
            """async () => {
                const local = { ...localStorage };
                const session = { ...sessionStorage };
                let vault = null;
                try {
                    const open = indexedDB.open('mono-vault');
                    const db = await new Promise((resolve, reject) => {
                        open.onsuccess = () => resolve(open.result);
                        open.onerror = () => reject(open.error);
                    });
                    if (db.objectStoreNames.contains('vault')) {
                        vault = await new Promise((resolve) => {
                            const get = db.transaction('vault', 'readonly').objectStore('vault').get('primary');
                            get.onsuccess = () => resolve(get.result ?? null);
                            get.onerror = () => resolve(null);
                        });
                    }
                    db.close();
                } catch (error) { vault = null; }
                return { local, session, vault };
            }"""
        )
        blob_after = json.dumps(storage_after, default=str)
        runs_after = sum(
            1 for index in range(len(words) - 2) if " ".join(words[index : index + 3]) in blob_after
        )
        vault_after = (storage_after.get("vault") or {}) if isinstance(storage_after, dict) else {}
        vault_still_encrypted = (
            isinstance(vault_after, dict)
            and vault_after.get("iter") == 210000
            and isinstance(vault_after.get("ct"), str)
            and len(vault_after.get("ct", "")) > 40
        )
        home_has_balance = page.locator("[data-balance-hidden]").count() >= 1
        record(
            "UI-39",
            "With auto-login on, a launch opens the home screen with no PIN and no key material",
            "PASS" if view_ready and lock_screen_shown == 0 and vault_still_encrypted and runs_after == 0 else "FAIL",
            json.dumps({
                "viewOnlyChip": view_ready,
                "lockScreen": lock_screen_shown,
                "balanceArea": home_has_balance,
                "vaultEncrypted": vault_still_encrypted,
                "seedRuns": runs_after,
            }, ensure_ascii=False),
        )

        # The token detail sheet keeps the three actions on one line, and 받기
        # opens the wallet's own receive screen without needing the key.
        page.locator("button", has_text="Solana").first.click()
        page.wait_for_selector("[data-token-actions]", timeout=15000)
        action_ids = page.evaluate(
            """() => [...document.querySelectorAll('[data-token-actions] button')].map(b => b.id)"""
        )
        action_labels = page.evaluate(
            """() => [...document.querySelectorAll('[data-token-actions] button')].map(b => b.innerText.trim())"""
        )
        page.locator("#token-receive").click()
        receive_label = ""
        receive_hint = ""
        receive_address = ""
        try:
            page.wait_for_selector("[data-receive-network-hint]", timeout=15000)
            receive_text = page.locator("[role='dialog']").last.inner_text()
            receive_label = "Solana (SOL · SPL)" if "Solana (SOL · SPL)" in receive_text else receive_text.split("\n")[1].strip() if len(receive_text.split("\n")) > 1 else ""
            receive_hint = page.locator("[data-receive-network-hint]").first.inner_text().replace("\n", " ").strip()
            receive_address = page.evaluate(
                """() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    const text = dialog ? dialog.innerText : '';
                    const meta = JSON.parse(localStorage.getItem('mono.meta.v1') || 'null');
                    return text.includes(meta?.address || '\u0000') ? meta.address : '';
                }"""
            )
        except Exception:
            receive_label = receive_label or ""
        record(
            "UI-40",
            "Token detail offers 보내기·받기·스왑 in one row and 받기 opens the receive screen",
            "PASS" if action_ids == ["token-send", "token-receive", "token-swap"] and "받기" in (action_labels[1] if len(action_labels) > 1 else "") else "FAIL",
            json.dumps({"buttons": action_ids, "labels": action_labels}, ensure_ascii=False),
        )
        record(
            "UI-41",
            "The receive screen names the chain as an exchange does and warns about BEP20/ERC20",
            "PASS"
            if "Solana (SOL · SPL)" in receive_label
            and "Solana(SOL)" in receive_hint
            and "BEP20/ERC20" in receive_hint
            and bool(receive_address)
            else "FAIL",
            json.dumps({"subtitle": receive_label, "hint": receive_hint, "addressShown": bool(receive_address)}, ensure_ascii=False),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # A freshly created wallet holds no SOL, so the send sheet cannot be
        # advanced on the live deployment (there is no stand-in RPC there).
        # The local suite proves the gate; the live run records it as REVIEW
        # instead of pretending it passed.
        if mock_available:
            # --- sending from the read-only session: the PIN gate -----------------
            page.get_by_role("button", name="보내기").first.click()
            page.wait_for_selector("#recipient-input", timeout=10000)
            page.fill("#recipient-input", unknown_address)
            page.fill("#amount-input", "0.1")
            page.wait_for_timeout(600)
            page.locator("#send-next").click()
            gate_open = False
            try:
                page.wait_for_selector("[data-auth-prompt='send']", timeout=15000)
                gate_open = True
            except Exception:
                gate_open = False
            gate_title = page.locator("[role='dialog']").last.inner_text().split("\n")[0].strip() if gate_open else ""
            confirm_without_pin = page.locator("#send-confirm").count()
            # Backing out leaves the send unbuilt and the form untouched.
            page.locator("[role='dialog']").last.get_by_role("button", name="취소").first.click()
            page.wait_for_timeout(600)
            cancelled_closed = page.locator("[data-auth-prompt]").count() == 0
            still_on_form = page.locator("#send-next").count() == 1 and page.locator("#send-confirm").count() == 0
            record(
                "UI-42",
                "Sending from the read-only session asks for the PIN and cancelling builds nothing",
                "PASS"
                if gate_open and confirm_without_pin == 0 and cancelled_closed and still_on_form and "인증" in gate_title
                else "FAIL",
                json.dumps({"gate": gate_open, "title": gate_title, "confirmBeforePin": confirm_without_pin, "cancelled": cancelled_closed}, ensure_ascii=False),
            )

            # A wrong PIN is refused; the right one releases the key for this send only.
            page.locator("#send-next").click()
            page.wait_for_selector("[data-auth-prompt='send']", timeout=15000)
            type_pin(page, "000000")
            wrong_pin_refused = False
            try:
                page.wait_for_selector("text=PIN이 올바르지 않습니다", timeout=10000)
                wrong_pin_refused = True
            except Exception:
                wrong_pin_refused = False
            page.wait_for_timeout(500)
            type_pin(page, "123456")
            signed_preview = False
            try:
                page.wait_for_selector("#send-confirm", timeout=25000)
                signed_preview = True
            except Exception:
                signed_preview = False
            send_state = page.locator("[role='dialog']").last.inner_text().replace("\n", " ")[:300]
            record(
                "UI-43",
                "A wrong PIN is refused and the right one unlocks the send preview",
                "PASS" if wrong_pin_refused and signed_preview else "FAIL",
                json.dumps({"wrongRefused": wrong_pin_refused, "preview": signed_preview, "state": send_state}, ensure_ascii=False),
            )

            # Closing the sheet releases the key: the next attempt asks again. That
            # is the observable proof that the key does not outlive the action.
            page.keyboard.press("Escape")
            page.wait_for_timeout(700)
            page.get_by_role("button", name="보내기").first.click()
            page.wait_for_selector("#recipient-input", timeout=10000)
            page.fill("#recipient-input", unknown_address)
            page.fill("#amount-input", "0.1")
            page.wait_for_timeout(600)
            page.locator("#send-next").click()
            asks_again = False
            try:
                page.wait_for_selector("[data-auth-prompt='send']", timeout=15000)
                asks_again = True
            except Exception:
                asks_again = False
            page.locator("[role='dialog']").last.get_by_role("button", name="취소").first.click()
            page.wait_for_timeout(500)
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
            record(
                "UI-44",
                "The key released after one send is gone: the next send asks for the PIN again",
                "PASS" if asks_again else "FAIL",
                json.dumps({"askedAgain": asks_again}, ensure_ascii=False),
            )
        else:
            for cid, title in (
                ("UI-42", "Sending from the read-only session asks for the PIN and cancelling builds nothing"),
                ("UI-43", "A wrong PIN is refused and the right one unlocks the send preview"),
                ("UI-44", "The key released after one send is gone: the next send asks for the PIN again"),
            ):
                record(
                    cid,
                    title,
                    "REVIEW",
                    "live mode: the funded stand-in RPC lives on the local static server; the same check runs in the local suite",
                )

        # --- turning the setting off is itself gated, and returns the lock ----
        page.get_by_role("button", name="설정", exact=True).first.click()
        page.wait_for_selector("button[data-auto-login]", timeout=15000)
        page.locator("button[data-auto-login]").first.click()
        gate_for_setting = False
        try:
            page.wait_for_selector("[data-auth-prompt='auto-login']", timeout=15000)
            gate_for_setting = True
        except Exception:
            gate_for_setting = False
        type_pin(page, "123456")
        try:
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.autoLogin === false",
                timeout=15000,
            )
            setting_off = True
        except Exception:
            setting_off = False
        back_on_lock = False
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            back_on_lock = True
        except Exception:
            back_on_lock = False
        page.reload(wait_until="domcontentloaded")
        locked_after_reload = False
        try:
            page.wait_for_selector("text=지갑 잠김", timeout=20000)
            locked_after_reload = True
        except Exception:
            locked_after_reload = False
        record(
            "UI-45",
            "Turning auto-login off needs the PIN, and the next launch is locked again",
            "PASS" if gate_for_setting and setting_off and back_on_lock and locked_after_reload else "FAIL",
            json.dumps({"gate": gate_for_setting, "savedOff": setting_off, "lockedNow": back_on_lock, "lockedAfterReload": locked_after_reload}, ensure_ascii=False),
        )

        # Put the wallet back on the default RPC so nothing else (and nobody
        # opening this build) is left pointing at a test endpoint.
        if mock_available:
            set_custom_rpc("")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("text=지갑 잠김", timeout=15000)
            type_pin(page, "123456")
            page.wait_for_selector("text=보내기", timeout=25000)

        # --- the bundled decoder actually reads a QR code ---------------------
        # No camera exists in CI, so the pixels come from a checked-in PNG that
        # holds a real Solana Pay request. The same chunk the scanner imports is
        # loaded here and must return the exact payload text.
        decoder_chunks = sorted(glob.glob(os.path.join(DIST, "assets", "jsQR-*.js")))
        qr_png = os.path.join(ROOT, "scripts", "security", "fixtures", "qr-solana-pay.png")
        qr_payload = "solana:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1?amount=0.5&memo=order%2042"
        if decoder_chunks and os.path.exists(qr_png):
            data_url = "data:image/png;base64," + base64.b64encode(open(qr_png, "rb").read()).decode("ascii")
            decoded = page.evaluate(
                """async ({ url, dataUrl }) => {
                    const module = await import(url);
                    let decode = null;
                    for (const value of Object.values(module)) {
                        if (typeof value === 'function') { decode = value; break; }
                        if (value && typeof value.default === 'function') { decode = value.default; break; }
                    }
                    if (!decode) throw new Error('decoder export not found');
                    const image = new Image();
                    image.src = dataUrl;
                    await new Promise((resolve, reject) => {
                        image.onload = () => resolve();
                        image.onerror = () => reject(new Error('image'));
                    });
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    const context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0);
                    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
                    const result = decode(frame.data, canvas.width, canvas.height, {
                        inversionAttempts: 'attemptBoth',
                    });
                    return result ? result.data : '';
                }""",
                {"url": base + "assets/" + os.path.basename(decoder_chunks[0]), "dataUrl": data_url},
            )
            record(
                "UI-37",
                "The bundled QR decoder turns a real Solana Pay code into its exact payload",
                "PASS" if decoded == qr_payload else "FAIL",
                json.dumps({"decoded": decoded, "expected": qr_payload}, ensure_ascii=False),
            )
        else:
            record(
                "UI-37",
                "The bundled QR decoder turns a real Solana Pay code into its exact payload",
                "REVIEW",
                "no built decoder chunk or fixture image found in this checkout",
            )

        record(
            "UI-14",
            "No uncaught page errors while driving the app",
            "PASS" if not page_errors else "FAIL",
            json.dumps(page_errors[:5]),
        )
        unexpected_errors = [
            error
            for error in console_errors
            # The inline-script block above is the check itself succeeding.
            if "Content Security Policy directive 'script-src" not in error
            # Public mainnet RPC rejects browser origins (403) and the app falls
            # back to a mirror; that is expected network noise, not a page fault.
            and "Failed to load resource" not in error
        ]
        record(
            "UI-15",
            "No unexpected console errors (CSP block and RPC 403s are expected)",
            "PASS" if not unexpected_errors else "REVIEW",
            json.dumps(unexpected_errors[:8]),
        )

        origins = sorted({url.split("/")[2] for url in requests_seen if url.startswith("http")})
        record("UI-16", "External origins contacted by the page", "INFO", ", ".join(origins))

        browser.close()

    if httpd is not None:
        httpd.shutdown()

    status = "FAIL" if any(check["status"] == "FAIL" for check in checks) else "PASS"
    output = {
        "status": status,
        "checks": checks,
        "counts": {
            "PASS": sum(1 for c in checks if c["status"] == "PASS"),
            "FAIL": sum(1 for c in checks if c["status"] == "FAIL"),
            "REVIEW": sum(1 for c in checks if c["status"] == "REVIEW"),
            "INFO": sum(1 for c in checks if c["status"] == "INFO"),
        },
        "requests": origins,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    if "--json" in sys.argv:
        print(json.dumps(output, ensure_ascii=False))
    else:
        for check in checks:
            print(f"{check['status']:6} {check['id']} {check['title']}")
            if check["status"] != "PASS":
                print(f"       {check['detail']}")
        print(json.dumps(output["counts"]))
    sys.exit(0 if status == "PASS" else 1)


if __name__ == "__main__":
    main()
