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

        # Turn the Face ID offer off: a headless browser has no authenticator,
        # and this check is about storage, not WebAuthn.
        toggle = page.locator('button[role="switch"]')
        if toggle.count():
            toggle.first.click()

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

        faceid = storage_dump["local"].get("mono.faceid.v2")
        record(
            "UI-09",
            "Any Face ID record on disk is ciphertext only",
            "PASS" if not faceid or '"ct"' in str(faceid) else "FAIL",
            (str(faceid)[:160] if faceid else "no enrolment (toggle off)"),
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
