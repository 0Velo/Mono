# Mono

**Mono** is a private Solana wallet that runs entirely in the browser. No account, no backend, no
telemetry — the seed phrase is encrypted on the device with a PIN and never leaves it.

**Live:** https://0velo.github.io/Mono/ · Installable as a PWA on iPhone (Safari → 홈 화면에 추가)

> The Pages path follows the repository name exactly as GitHub stores it (`Mono`), so the canonical
> address is `/Mono/`. The build uses relative asset paths, so it also works unchanged if the
> repository is ever renamed to lowercase `mono` (which would make `/mono/` the address).

---

## 한국어

Mono는 브라우저 안에서만 동작하는 개인 솔라나 지갑입니다. 서버가 없고, 계정도 없고, 키는
기기 밖으로 나가지 않습니다.

### 주요 기능

- **지갑** — SOL · SPL 잔액과 평가금액, 24시간 변동, 실시간 시세(CoinGecko → Binance → DexScreener 폴백)
- **보내기 / 받기** — 주소·수량 확인 단계, 토큰 계정 생성 수수료 미리 표시, Solscan 링크, QR 받기. 전송은 RPC가 서명을 받아들이는 즉시 결과 화면으로 넘어가고, 확정 확인은 HTTPS 조회로 최대 30초만 기다린 뒤 서명 해시와 함께 명확한 상태를 남깁니다
- **QR로 보내기** — 송금 화면의 QR 버튼으로 카메라를 열어 솔라나 주소나 `solana:<주소>?amount=…&spl-token=…&memo=…` Solana Pay 코드를 읽고 주소·금액·토큰·메모를 한 번에 채웁니다. Android Chrome은 `BarcodeDetector`, iOS Safari는 번들에 포함된 `jsQR` 디코더(외부 스크립트·CDN 없음)를 쓰고, 권한이 없거나 카메라가 없으면 안내만 남기고 스트림을 즉시 닫습니다
- **보내기 전 확인** — 받는 주소가 내 계정이면 `내 계정 2`, 주소록이면 저장한 이름 배지를, 처음 보내는 주소면 `처음 보내는 주소` 칩을 보여 주고, 금액을 넣으면 수수료·계정 생성비까지 뺀 `보낸 뒤 잔액`과 0에 가까워질 때의 경고를 한 줄로 표시합니다
- **프라이버시 모드** — 홈 화면의 총 잔액을 탭하면 `••••`로 가려지고 다시 탭하면 보입니다. 선택은 기기에 저장되어 앱을 다시 열어도 유지됩니다
- **빈 토큰 계정 정리** — 잔액이 0이고 동결되지 않은 토큰 계정이 있으면 설정에 `빈 토큰 계정 N개 정리 · 약 +0.00XX SOL`이 나타납니다. 서명 전 시뮬레이션으로 회수 금액과 닫힐 계정을 확인한 뒤 `createCloseAccountInstruction`으로 계정을 닫아 묶여 있던 SOL rent를 돌려받습니다
- **주소록** — "투빗 입금", "내 팬텀" 같은 이름으로 저장하고 보내기 화면에서 한 번에 선택
- **계정** — 같은 시드 문구에서 `m/44'/501'/n'/0'` 파생. 최대 100개까지 추가·전환·이름 변경·삭제할 수 있고, 삭제한 번호를 다시 추가하면 같은 주소가 돌아옵니다
- **스왑** — Jupiter 애그리게이터 견적·실행, 슬리피지(0.5 / 1 / 3%), 가격 영향·최소 수령·경로 표시
- **토큰 상세** — 가격 차트(1일/7일), 관심 목록(★), 보안 체크(민트 권한·동결 권한·Token-2022 확장). 하단에 `보내기 · 받기 · 스왑` 세 버튼이 한 줄로 있고, 받기는 그 토큰을 받을 주소·QR 화면으로 바로 연결됩니다
- **받기 화면의 네트워크 표기** — 거래소 출금 화면과 같은 `Solana (SOL · SPL)`로 적고, `거래소 출금 시 반드시 Solana(SOL) 네트워크 · BEP20/ERC20 불가` 한 줄을 함께 둡니다(Devnet은 `Solana Devnet`으로 구분)
- **조회 자동 로그인 (선택)** — 설정 → 보안에서 켜면 앱을 열 때 PIN 없이 홈(잔액·토큰·차트·받기·거래내역)이 바로 뜨고, 왼쪽 위에 `조회 전용` 칩이 붙습니다. 이때 시드 문구·개인키는 메모리에 올리지 않고 암호화된 금고에만 남기며, 화면은 주소·이름·잔액 같은 공개 데이터만 씁니다. **송금·스왑·빈 계정 정리·시드 문구 확인·백업 내보내기·보안 설정 변경·계정 관리**를 실행할 때만 인증 시트가 PIN을 묻고, 확인 뒤에야 금고를 복호화해 그 작업에만 키를 쓰고 끝나면 곧바로 0으로 덮어 지웁니다(작업이 멈춰도 3분 뒤 자동 삭제). 끄는 것도 PIN 확인을 거치고 즉시 잠금 화면으로 돌아갑니다
- **숨긴 토큰** — 에어드랍 스팸을 목록에서 숨기고 필요할 때만 다시 보기
- **다크 모드** — 라이트 / 다크 / 시스템, 설정에 저장되고 첫 페인트 전에 적용
- **첫 화면** — 앱을 열면 블랙 클레이 마스코트가 곧바로 뜨고, 금고를 읽는 동안 흰 화면이 보이지 않습니다. 마스코트는 살짝 떠오르며 나타나 천천히 떠다니고, 최소 1.15초 노출된 뒤 0.38초에 걸쳐 사라집니다(동작 줄이기 설정에서는 애니메이션 없이 바로 표시)
- **입출금 알림** — 설정에서 켜면 입금·출금·스왑을 OS 알림과 화면 안 토스트로 알립니다. 앱이 열려 있는 동안은 기기가 20초마다 직접 조회하고, **앱을 닫아 둔 동안의 입금**은 `설정 → 알림 → 백그라운드 Web Push`로 기기를 등록하면 푸시 서버가 알려 줍니다(주소·금액 없이 "입금 감지"만). iPhone은 홈 화면에 추가한 앱에서만 웹 알림 권한을 줄 수 있습니다
- **고래 지갑 알림 (Wallet Watch)** — `설정 → 알림 → 고래 지갑 알림`에서 추적할 외부 솔라나 지갑의 **공개 주소와 별명**(예: `고래 1`, `트레이더 A`)을 추가·이름 변경·삭제하고 알림을 켜고 끌 수 있습니다(최대 20개). 시트 위쪽의 **추천 고래 15명**은 칩 하나로 1명, `전체 추가`로 한 번에 넣을 수 있고 이미 등록된 주소는 `추가됨`으로 표시됩니다(저장 1회, `/v1/watch` 동기화 1회). 백그라운드 Web Push를 켜면 그 주소들이 Helius **메인넷** 웹훅에 함께 등록되어, 스왑·송금이 감지되면 `[고래 1] 스왑 감지` / `Mainnet · SOL · token …`처럼 **내 지갑 알림과 구분되는** 푸시가 옵니다(금액은 넣지 않음). 공개 주소만 서버로 가고 키·서명은 필요 없어서 조회 전용(자동 로그인) 상태에서도 목록을 고칠 수 있습니다

### 보안 구조

| 항목 | 방식 |
| --- | --- |
| 키 보관 | PBKDF2-SHA256(210,000회) → AES-256-GCM. 암호화된 금고만 기기에 저장 |
| 저장 위치 | **IndexedDB** (`mono-vault`). 구버전 `localStorage` 금고는 최초 실행 시 자동 이전 후 삭제 |
| 잠금 해제 | 6자리 PIN (생체인증 로그인은 지원하지 않음) |
| 조회 자동 로그인 | 공개 데이터(주소·계정 목록·잔액·토큰·내역)만으로 홈을 엽니다. 니모닉·개인키는 이 상태에서 메모리에 없고 암호화 금고에만 있습니다. 키가 필요한 작업은 `requestAuth(목적)` 한 곳을 거쳐 PIN 확인 뒤에만 키를 받고, 작업이 끝나면 `endAuthSession()`이 바이트를 덮어씁니다(최대 3분) |
| 잠금 시 | 복호화된 키페어의 `secretKey` 바이트를 `fill(0)`으로 덮어쓰고 메모리 참조 해제 |
| 전송 계층 | HTTPS + `Content-Security-Policy` (`script-src 'self'`, 인라인 스크립트 없음, `form-action 'none'`, `frame-src 'none'`) |
| RPC 연결 | 지정한 RPC로 HTTPS와 WebSocket(wss)을 연결합니다. `connect-src`는 사용자 지정 RPC를 위해 `https:`·`wss:`를 허용합니다(스크립트는 `self`만) |
| 스왑 서명 | Jupiter가 만든 트랜잭션을 **서명 전에** 검사: 수수료 지불자·서명자 확인, 허용 프로그램 목록, System/토큰 권한 명령 차단, 시뮬레이션 잔액 변화가 견적과 일치하는지 확인 |
| QR·메모 | 스캔·붙여넣기한 텍스트는 주소(32바이트)·금액(부호·지수 없는 10진수) 형식을 모두 통과할 때만 채워지고, 하나라도 어긋나면 요청 전체를 거부합니다. 메모는 계정·서명자가 없는 Memo 프로그램 명령 한 줄로만 전송되며 길이가 제한됩니다 |
| 빈 계정 정리 | 잔액 0·비동결·내가 닫을 수 있는 계정만 대상. 시뮬레이션에서 지갑 lamport 증가분이 rent 합계에서 수수료를 뺀 값과 같고 대상 계정이 모두 사라졌을 때만 서명합니다 |
| RPC | 사용자 지정 RPC는 https만 허용(로컬 검증기용 localhost 예외) |
| 백업 | PIN으로 암호화된 `.json` 한 개. 파일 안에 시드 문구 평문은 없음 |

보안 감사 결과와 자동 검사 방법은 [`docs/SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md)에
정리되어 있습니다. 직접 돌려 보려면:

```bash
npm run test:security        # 정적 검사 + 비밀키 스캔 + npm audit + crypto/tx 단위 테스트
npm run test:security:ui     # 빌드된 앱을 Chromium에서 실제로 구동 (CSP·저장소·pagehide·XSS·계정 6개 추가/이름/삭제·QR 스캔·보낸 뒤 잔액·프라이버시 모드·QR 디코더)
npm run test:send            # 모의 Devnet RPC로 송금 확인·타임아웃·RPC 오류·실패 경로를 브라우저에서 확인
npm run security:gate        # 배포 차단 게이트 (Critical/High)
```

Mono는 비수탁(non-custodial) 지갑입니다. 시드 문구와 PIN을 잃으면 복구할 수 없고, 누구도
대신 복구해 줄 수 없습니다.

### iPhone에 설치

1. Safari에서 https://0velo.github.io/Mono/ 열기
2. 공유 → **홈 화면에 추가**
3. 홈 화면 아이콘으로 실행 (주소창 없는 전체 화면, PIN으로 잠금 해제)

### RPC 설정 (선택)

기본값은 솔라나 공용 RPC입니다. 요청 제한(429/403)이 잦다면 설정 → 네트워크에서 개인 RPC를
넣으세요.

```
https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

무료 키: https://dashboard.helius.dev/api-keys (QuickNode도 동일한 형식)

### 백그라운드 Web Push 서버

앱을 닫아 둔 동안의 입금을 알리는 서버는 `push-server/`에 있고 Vercel에 따로 배포됩니다.

| 항목 | 값 |
| --- | --- |
| 서버 | `https://mono-push-server.vercel.app` (빌드 시 `VITE_PUSH_API_URL`로 주입) |
| 엔드포인트 | `GET /v1/config` · `POST /v1/subscriptions` · `DELETE /v1/subscriptions/{id}` |
| 감시 | `GET|POST /api/cron/scan` (`Authorization: Bearer $CRON_SECRET`, Vercel Cron + 외부 스케줄러) |
| 저장소 | Neon Postgres `mono_push_kv` 한 테이블 (Vercel Storage) |
| 받지 않는 것 | 시드·개인키·PIN. 계정 연결은 잠금 해제 중 지갑이 만든 Ed25519 서명 한 번으로 증명합니다 |

서버는 푸시 endpoint·암호화 키·주소·네트워크·관리토큰의 SHA-256 해시만 보관하고, 알림에는
금액이나 거래 내역을 넣지 않습니다. 계약·환경변수·한계는 [`push-server/README.md`](push-server/README.md).

### 개발

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # tsc --noEmit && vite build
npm run preview
```

GitHub Actions는 빌드·보안 검사·브라우저 테스트가 모두 성공한 뒤에만 `main`에서 GitHub Pages를
배포합니다. Pull request에서는 검사만 실행하며 배포하지 않습니다.

---

## English

**Mono** is a non-custodial Solana wallet PWA. Everything — key derivation, signing, price lookups —
happens client-side. There is no server component and no analytics.

### Features

- **Portfolio** — SOL + SPL balances, USD/KRW value, 24h change, keyless price fallbacks
- **Send / Receive** — confirmation step, ATA rent disclosure, QR receive sheet, Solscan links
- **Address book** — label recurring recipients and pick them with one tap in the send sheet
- **Accounts** — up to 100 accounts from one seed (`m/44'/501'/n'/0'`), each addable, renamable and removable; a removed index comes back with the same address
- **Swap** — Jupiter quote/execute, slippage presets, price impact, minimum received, route
- **Token detail** — 1d/7d chart, watchlist star, on-chain security check (mint/freeze authority, Token-2022 extensions), and one row of `Send · Receive · Swap` where Receive opens that wallet's address/QR sheet
- **Read-only auto-login (optional)** — with it on (Settings → Security), opening the app goes straight to the home screen with no PIN and a `조회 전용` chip. Nothing is decrypted: balances, tokens and history come from the public address. Sending, swapping, closing empty accounts, revealing the seed, exporting a backup, changing security settings and account management each open one PIN sheet first, and the key that sheet releases is zeroed as soon as the action ends (three minutes at most)
- **Spam control** — hide any SPL token from the wallet list
- **Theme** — light / dark / system, persisted and applied before first paint
- **Splash** — the black clay mascot paints from plain HTML before any script runs, floats in and breathes for at least 1.15s, then fades over 0.38s once the vault is read (motion respects `prefers-reduced-motion`)
- **Activity alerts** — optional deposit / withdrawal / swap notices as OS notifications plus in-app toasts. No backend: the device polls its own RPC every 20 seconds, so alerts exist only while the app is open. iPhone grants web notification permission only to the Home Screen app

### Security model

- Vault: `PBKDF2-SHA256 (210k) → AES-256-GCM`, stored in **IndexedDB** (`mono-vault`). Legacy
  `localStorage` vaults are migrated once and deleted.
- Unlock: 6-digit PIN only; biometric authentication is not supported.
- Read-only auto-login: public data only, no key in memory. A key is released by a single PIN gate
  (`requestAuth(purpose)`) and zeroed by `endAuthSession()` when the action finishes.
- On lock: the decrypted `secretKey` bytes are zeroed with `fill(0)` and the payload reference dropped.
- Transport: HTTPS plus a strict `Content-Security-Policy` (`script-src 'self'`, no inline scripts).
- Backup: a single PIN-encrypted `.json`; the mnemonic is never written in plaintext.

### Architecture

```
src/
├─ lib/
│  ├─ derive.ts       SLIP-0010 ed25519 derivation (m/44'/501'/n'/0')
│  ├─ wallet.ts       mnemonic/secret key → Keypair (intermediate buffers zeroed)
│  ├─ vault.ts        PBKDF2 + AES-256-GCM sealed payload
│  ├─ vaultStore.ts   IndexedDB vault + one-time localStorage migration
│  ├─ idb.ts          minimal IndexedDB helper (vault + legacy vault migration)
│  ├─ swap.ts         Jupiter quote/swap client with endpoint fallbacks
│  ├─ chart.ts        price history (CoinGecko → Binance)
│  ├─ security.ts     mint/freeze authority + Token-2022 extension probe
│  ├─ prefs.ts        hidden tokens, watchlist, privacy mode
│  ├─ addressBook.ts  saved recipients
│  ├─ solanaPay.ts    Solana Pay URI / 주소 / 금액 / 메모 파서
│  ├─ qrScan.ts       카메라 QR 스캔 (BarcodeDetector → 번들 jsQR 폴백)
│  ├─ sendSafety.ts   받는 주소 별명 배지, 보낸 뒤 잔액
│  ├─ rent.ts         빈 토큰 계정 조회·시뮬레이션·closeAccount
│  ├─ theme.ts        light/dark/system, CSS-variable switching
│  ├─ splash.ts       static splash hand-off (minimum on-screen time, one-shot fade, lock-screen landing)
│  ├─ splashLanding.ts  where the saucer sets the alien down: mark coordinates, shrink ratio, beat timings
│  ├─ activityNotifications.ts  transaction → 입금/출금/스왑 classification, seen-signature baseline, permission + delivery
│  ├─ tokens.ts       balances, SPL accounts, on-chain metadata
│  └─ prices.ts       keyless price sources
├─ screens/           Onboarding, Lock, Home, Swap (lazy), Activity, Settings
├─ sheets/            Send, Receive, TokenDetail (lazy), Accounts, AddressBook, Backup, Reset, Rent
└─ state/             WalletProvider (vault, explicitly selected accounts, auto-lock)
```

The entry chunk stays small: `@solana/web3.js`, `bip39`, Jupiter and the chart code are separate
lazy chunks, warmed during idle time after the lock screen appears.

### Development

```bash
npm install && npm run dev
npm run build   # production bundle into dist/
```

Font subset regeneration (after adding Korean UI copy):

```bash
python3 tmp/make-font-subset.py   # needs fonttools + brotli
```

Splash art regeneration (from the master in `design/masters/mono-alien-master.png`):

```bash
python3 - <<'PY'
from PIL import Image
im = Image.open('design/masters/mono-alien-master.png').convert('RGBA')
box = im.split()[-1].getbbox()
crop = im.crop((box[0]-10, box[1]-10, box[2]+10, box[3]+10))
w, h = round(crop.width * 512 / max(crop.size)), round(crop.height * 512 / max(crop.size))
crop.resize((w, h), Image.LANCZOS).save('public/assets/splash/mono-alien.webp', 'WEBP', quality=88, method=6)
PY
```

---

MIT · Built for personal use by [@Cbalhub](https://github.com/Cbalhub)
