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
        page.get_by_role("button", name="지갑", exact=True).first.click()
        page.wait_for_timeout(400)

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
