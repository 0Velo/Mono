#!/usr/bin/env python3
"""Browser proof that a Devnet send never leaves the spinner stuck.

The real built app runs in Chromium while every JSON-RPC call is answered by
scripts/security/send/mock-rpc-server.mjs. MODE selects how confirmation
behaves, so each branch of the send flow is exercised end to end in a browser:

  confirm -> the sheet reaches "전송 완료" with a Solscan link
  stall   -> getSignatureStatuses never confirms; the sheet leaves the
             "전송 중" spinner immediately and reports the pending signature
  error   -> every status read fails; the sheet reports an unknown result
  fail    -> the cluster reports an on-chain error; the sheet says so

Usage:
  npm run build
  npm run test:send                                  # all four paths
  MODE=stall python3 scripts/security/send/send-e2e.py
  MODE=stall python3 scripts/security/send/send-e2e.py --base https://0velo.github.io/Mono/
"""
import http.server
import json
import os
import pathlib
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[3]
DIST = ROOT / "dist"
NODE = os.environ.get("NODE_BIN", "node")
RECIPIENT = "6gfaPbAZkbZJfAifetCeA7g59ZTYLh4piaNNkK6dunhJ"
MODES = ("confirm", "stall", "error", "fail")
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
}
TERMINAL_LABELS = (
    "전송 완료",
    "전송 성공 확인",
    "네트워크 확인 중",
    "전송 실패 확인",
    "블록해시 만료",
    "전송 결과 불명확",
)
SETTLE_MARKERS = (
    "새 서명을 만들지 마세요",
    "같은 서명이 아직 확정되지 않았습니다",
    "전송 결과를 확인하지 못했습니다",
    "재전송하지 마세요",
)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, *args):
        pass


def type_pin(page, pin):
    for digit in pin:
        page.locator(f'button[aria-label="{digit}"]').click()
        page.wait_for_timeout(35)


def start_mock(mode, port):
    bundle = ROOT / "tmp" / "mock-rpc-server.bundle.mjs"
    if not bundle.exists():
        raise SystemExit("run `npm run test:send` (or node scripts/security/send/prepare.mjs) first")
    log_path = ROOT / "tmp" / f"mock-{mode}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [NODE, str(bundle)],
        cwd=str(ROOT),
        env={**os.environ, "MODE": mode, "PORT": str(port)},
        stdout=open(log_path, "w"),
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return proc
        except OSError:
            time.sleep(0.15)
    raise RuntimeError("mock RPC did not start")


def run_mode(mode, base):
    mock_port = free_port()
    mock = start_mock(mode, mock_port)
    result = {"mode": mode, "base": base, "steps": [], "console": []}

    def rpc_bridge(route):
        request = route.request
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS)
            return
        try:
            body = (request.post_data or "{}").encode()
            outgoing = urllib.request.Request(
                f"http://127.0.0.1:{mock_port}/",
                data=body,
                headers={"content-type": "application/json"},
            )
            with urllib.request.urlopen(outgoing, timeout=15) as response:
                payload = response.read().decode()
            route.fulfill(status=200, headers={**CORS, "content-type": "application/json"}, body=payload)
        except Exception as error:  # noqa: BLE001 - reported, never hidden
            route.fulfill(
                status=500,
                headers={**CORS, "content-type": "application/json"},
                body=json.dumps(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": str(error)}}
                ),
            )

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox"])
            context = browser.new_context(
                viewport={"width": 430, "height": 900},
                locale="ko-KR",
                timezone_id="Asia/Seoul",
            )
            page = context.new_page()
            page.route("https://api.devnet.solana.com/**", rpc_bridge)
            page.route("https://api.mainnet-beta.solana.com/**", lambda route: route.abort())
            page.route("https://solana-rpc.publicnode.com/**", lambda route: route.abort())
            page.route("https://solana.drpc.org/**", lambda route: route.abort())
            page.on(
                "console",
                lambda msg: result["console"].append(msg.text)
                if msg.type == "error" and "WebSocket" not in msg.text
                else None,
            )

            page.goto(base, wait_until="domcontentloaded")
            page.wait_for_selector("text=새 지갑 만들기", timeout=25000)
            page.get_by_role("button", name="새 지갑 만들기").click()
            page.wait_for_selector("text=시드 문구를 안전한 곳에 적어 두었습니다.", timeout=20000)
            page.get_by_text("시드 문구를 안전한 곳에 적어 두었습니다.").click()
            page.get_by_role("button", name="다음").click()
            page.wait_for_selector("text=PIN 설정", timeout=10000)
            type_pin(page, "123456")
            page.wait_for_selector("text=PIN 확인", timeout=10000)
            type_pin(page, "123456")
            page.wait_for_selector("text=보내기", timeout=30000)
            result["steps"].append("wallet created")

            page.get_by_role("navigation").get_by_role("button", name="설정", exact=True).click()
            page.wait_for_selector("text=네트워크", timeout=10000)
            page.get_by_role("button", name="Devnet", exact=True).click()
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('mono.meta.v1') || 'null')?.network === 'devnet'",
                timeout=10000,
            )
            result["steps"].append("network=devnet")
            page.get_by_role("navigation").get_by_role("button", name="지갑", exact=True).click()
            page.wait_for_timeout(1200)

            page.get_by_role("button", name="보내기").first.click()
            page.wait_for_selector("#recipient-input", timeout=10000)
            page.fill("#recipient-input", RECIPIENT)
            page.wait_for_selector("text=Devnet에서는 테스트용 SOL만 전송됩니다", timeout=10000)
            page.fill("#amount-input", "0.01")
            page.wait_for_timeout(400)
            page.get_by_role("button", name="다음").click()
            page.wait_for_selector("text=시뮬레이션 잔액 변화", timeout=40000)
            result["steps"].append("preview ready")

            started = time.time()
            page.get_by_role("button", name="시뮬레이션 내용대로 서명·전송").click()

            outcome = ""
            outcome_after = None
            deadline = time.time() + 60
            while time.time() < deadline:
                text = page.evaluate("() => document.querySelector('[role=\"dialog\"]')?.innerText ?? ''")
                for label in TERMINAL_LABELS:
                    if label in text:
                        outcome = label
                        outcome_after = round(time.time() - started, 1)
                        break
                if outcome:
                    break
                page.wait_for_timeout(400)

            settled_after = None
            settle_deadline = time.time() + 45
            while time.time() < settle_deadline:
                text = page.evaluate("() => document.querySelector('[role=\"dialog\"]')?.innerText ?? ''")
                if any(marker in text for marker in SETTLE_MARKERS):
                    settled_after = round(time.time() - started, 1)
                    break
                page.wait_for_timeout(500)

            dialog_text = page.evaluate("() => document.querySelector('[role=\"dialog\"]')?.innerText ?? ''")
            result.update(
                {
                    "outcome": outcome,
                    "outcomeAfterSeconds": outcome_after,
                    "settledAfterSeconds": settled_after,
                    "dialogText": dialog_text[:900],
                    "hasExplorerLink": page.locator("text=Solscan에서").count() > 0,
                    "sendingSpinnerStillVisible": "전송 중" in dialog_text and not outcome,
                }
            )
            (ROOT / "tmp").mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / "tmp" / f"send-{mode}.png"))
            browser.close()
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()
    return result


def main():
    base_arg = None
    if "--base" in sys.argv:
        base_arg = sys.argv[sys.argv.index("--base") + 1]
    modes = MODES
    wanted = os.environ.get("MODE")
    if wanted and wanted != "all":
        modes = tuple(mode.strip() for mode in wanted.split(",") if mode.strip())
        unknown = [mode for mode in modes if mode not in MODES]
        if unknown:
            raise SystemExit(f"unknown MODE {unknown}; choose from {MODES}")

    httpd = None
    if base_arg:
        base = base_arg.rstrip("/") + "/"
    else:
        port = free_port()
        httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{port}/"

    results = []
    try:
        for mode in modes:
            if not DIST.exists() and not base_arg:
                raise SystemExit("no dist/ build — run `npm run build` first")
            results.append(run_mode(mode, base))
    finally:
        if httpd is not None:
            httpd.shutdown()

    print(json.dumps(results, ensure_ascii=False, indent=1))
    failures = []
    for result in results:
        mode = result["mode"]
        if result["outcome"] not in TERMINAL_LABELS or result["sendingSpinnerStillVisible"]:
            failures.append(f"{mode}: the sheet never left the sending spinner ({result['outcome']!r})")
            continue
        if mode == "confirm" and result["outcome"] != "전송 완료":
            failures.append(f"confirm: expected 전송 완료, saw {result['outcome']!r}")
        if mode in {"stall", "error"} and not result["settledAfterSeconds"]:
            failures.append(f"{mode}: the confirmation loop did not end with a reported outcome")
        if mode in {"stall", "error", "fail"} and not result["hasExplorerLink"]:
            failures.append(f"{mode}: no Solscan link for the signature to track")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        sys.exit(1)
    print("PASS all send paths ended in a visible state")


if __name__ == "__main__":
    main()
