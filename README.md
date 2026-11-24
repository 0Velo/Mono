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
- **보내기 / 받기** — 주소·수량 확인 단계, 토큰 계정 생성 수수료 미리 표시, Solscan 링크, QR 받기
- **주소록** — "투빗 입금", "내 팬텀" 같은 이름으로 저장하고 보내기 화면에서 한 번에 선택
- **계정 전환** — 같은 시드 문구에서 `m/44'/501'/n/0'` 파생. 이름을 붙여 여러 계정을 오가며 사용
- **스왑** — Jupiter 애그리게이터 견적·실행, 슬리피지(0.5 / 1 / 3%), 가격 영향·최소 수령·경로 표시
- **토큰 상세** — 가격 차트(1일/7일), 관심 목록(★), 보안 체크(민트 권한·동결 권한·Token-2022 확장)
- **숨긴 토큰** — 에어드랍 스팸을 목록에서 숨기고 필요할 때만 다시 보기
- **다크 모드** — 라이트 / 다크 / 시스템, 설정에 저장되고 첫 페인트 전에 적용

### 보안 구조

| 항목 | 방식 |
| --- | --- |
| 키 보관 | PBKDF2-SHA256(210,000회) → AES-256-GCM. 암호화된 금고만 기기에 저장 |
| 저장 위치 | **IndexedDB** (`mono-vault`). 구버전 `localStorage` 금고는 최초 실행 시 자동 이전 후 삭제 |
| 잠금 해제 | 6자리 PIN 또는 Face ID(WebAuthn platform authenticator, `userVerification: required`) |
| Face ID 봉인 | PRF 지원 시 HKDF로 키 유도, 미지원(iOS Safari/PWA) 시 **추출 불가능한** AES 키를 IndexedDB에 보관하고 인증 성공 후에만 사용 |
| 잠금 시 | 복호화된 키페어의 `secretKey` 바이트를 `fill(0)`으로 덮어쓰고 메모리 참조 해제 |
| 전송 계층 | HTTPS + `Content-Security-Policy` (`script-src 'self'`, 인라인 스크립트 없음) |
| 백업 | PIN으로 암호화된 `.json` 한 개. 파일 안에 시드 문구 평문은 없음 |

Mono는 비수탁(non-custodial) 지갑입니다. 시드 문구와 PIN을 잃으면 복구할 수 없고, 누구도
대신 복구해 줄 수 없습니다.

### iPhone에 설치

1. Safari에서 https://0velo.github.io/Mono/ 열기
2. 공유 → **홈 화면에 추가**
3. 홈 화면 아이콘으로 실행 (주소창 없는 전체 화면, 생체 인증 사용 가능)

### RPC 설정 (선택)

기본값은 솔라나 공용 RPC입니다. 요청 제한(429/403)이 잦다면 설정 → 네트워크에서 개인 RPC를
넣으세요.

```
https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

무료 키: https://dashboard.helius.dev/api-keys (QuickNode도 동일한 형식)

### 개발

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # tsc --noEmit && vite build
npm run preview
```

배포는 `tmp/deploy.sh` — `main`에 소스를, `dist/`를 `gh-pages`에 올리고 GitHub Pages를 갱신합니다.
(https://0velo.github.io/Mono/)

---

## English

**Mono** is a non-custodial Solana wallet PWA. Everything — key derivation, signing, price lookups —
happens client-side. There is no server component and no analytics.

### Features

- **Portfolio** — SOL + SPL balances, USD/KRW value, 24h change, keyless price fallbacks
- **Send / Receive** — confirmation step, ATA rent disclosure, QR receive sheet, Solscan links
- **Address book** — label recurring recipients and pick them with one tap in the send sheet
- **Accounts** — multiple accounts from one seed (`m/44'/501'/n/0'`) with custom nicknames
- **Swap** — Jupiter quote/execute, slippage presets, price impact, minimum received, route
- **Token detail** — 1d/7d chart, watchlist star, on-chain security check (mint/freeze authority, Token-2022 extensions)
- **Spam control** — hide any SPL token from the wallet list
- **Theme** — light / dark / system, persisted and applied before first paint

### Security model

- Vault: `PBKDF2-SHA256 (210k) → AES-256-GCM`, stored in **IndexedDB** (`mono-vault`). Legacy
  `localStorage` vaults are migrated once and deleted.
- Unlock: 6-digit PIN, or Face ID via WebAuthn platform authenticator (`userVerification: required`).
  - PRF-capable authenticators derive the AES key with HKDF (nothing persisted).
  - Without PRF (common on iOS Safari/PWA) a **non-extractable** AES key is kept in IndexedDB and
    only used after a successful assertion.
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
│  ├─ idb.ts          minimal IndexedDB helper (vault + Face ID key stores)
│  ├─ biometric.ts    WebAuthn enrolment, PRF or device-key sealing
│  ├─ swap.ts         Jupiter quote/swap client with endpoint fallbacks
│  ├─ chart.ts        price history (CoinGecko → Binance)
│  ├─ security.ts     mint/freeze authority + Token-2022 extension probe
│  ├─ prefs.ts        hidden tokens, watchlist
│  ├─ addressBook.ts  saved recipients
│  ├─ theme.ts        light/dark/system, CSS-variable switching
│  ├─ tokens.ts       balances, SPL accounts, on-chain metadata
│  └─ prices.ts       keyless price sources
├─ screens/           Onboarding, Lock, Home, Swap (lazy), Activity, Settings
├─ sheets/            Send, Receive, TokenDetail (lazy), Accounts, AddressBook, Backup, Reset
└─ state/             WalletProvider (vault, accounts, auto-lock, Face ID)
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

---

MIT · Built for personal use by [@Cbalhub](https://github.com/Cbalhub)
