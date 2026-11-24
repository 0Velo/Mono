# Sol Wallet

Phantom 스타일의 개인 솔라나 지갑 PWA. React 18 + Vite + TypeScript + Tailwind, 실제
Mainnet/Devnet 연결, 기기 내 PIN 암호화(AES-GCM), iOS 홈 화면 설치를 지원합니다.

```
/workspace/work/sol-wallet
├─ src/
│  ├─ lib/
│  │  ├─ derive.ts   SLIP-0010 ed25519 파생 (Phantom과 동일한 m/44'/501'/0'/0')
│  │  ├─ wallet.ts   니모닉/개인키 → Keypair, 주소 검증
│  │  ├─ vault.ts    PBKDF2-SHA256(210k) + AES-256-GCM 로컬 금고
│  │  ├─ rpc.ts      네트워크/RPC, CORS 폴백, Solscan 링크
│  │  ├─ tokens.ts    잔액·SPL 토큰 계정·온체인 메타데이터
│  │  ├─ prices.ts    CoinGecko → Binance/er-api → DexScreener 폴백 시세
│  │  └─ tx.ts        SOL/SPL 전송, 수수료·계정 생성비 추정, 거래내역 파싱
│  ├─ state/WalletProvider.tsx   잠금/해제, 자동 잠금, 메타 저장
│  ├─ screens/  Onboarding · LockScreen · Home · Activity · Settings
│  └─ sheets/   SendSheet · ReceiveSheet · BackupSheet · ResetSheet
├─ public/  manifest.json, sw.js, icons/, fonts/PretendardVariable.woff2, assets/3d/
├─ design/  masters/(원본 1000px) · originals/(교체 전 아이콘 백업)
└─ screenshots/  390×844 iPhone 뷰포트 캡처
```

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 타입체크 + 프로덕션 빌드 (dist/)
npm run preview    # 빌드 결과 미리보기 (http://localhost:4173)
```

Node 18+ 필요. 이 환경에서는 Node가 `/workspace/.tools/node/bin`에 있으므로
`export PATH=/workspace/.tools/node/bin:$PATH` 후 실행합니다.

## 디자인

화이트(`#FFFFFF`) + 잉크 블랙(`#0D0E12`) 극미니멀. 회색 표면(`#F5F6F8`)만 쓰고 테두리·카드
그림자·보라색 그라데이션은 쓰지 않습니다. 포인트 컬러는 상승/확인 `#16A34A`, 오류/삭제
`#EF4444` 두 가지뿐입니다. 큰 숫자는 Pretendard 700 + `-0.03em` 트래킹 + `tabular-nums`,
토큰 아이콘은 단색 SVG 마크(스테이블·JUP·RAY) 또는 2글자 모노그램입니다.

### 3D 클레이 에셋

온보딩 히어로와 SOL 토큰 아이콘은 순백 배경으로 렌더한 무광 3D 클레이 에셋을 씁니다.

- `public/assets/3d/wallet-hero.png` (600px) — 온보딩 히어로 164px 박스(오브제 ≈123px)
- `public/assets/3d/sol-coin.png` (240px) — SOL 토큰 아이콘 40px(토큰 목록·거래내역)·52px(전송 카드)
- 배경은 #FFFFFF이고 `<img>`에 `mix-blend-multiply`를 걸어 흰 배경이 페이지·`#F5F6F8`
  원형 위에서 완전히 사라집니다(사각 박스 아티팩트 0). 그래서 배경 제거 PNG가 필요 없습니다.
- 로드 실패 시에는 기존 단색 SOL 글리프로 자동 폴백합니다(`SolCoin3D`).
- 마스터 원본은 `design/masters/`, 교체 전 아이콘은 `design/originals/`에 보관합니다.
- 앱 아이콘(`icon-512`·`icon-192`·`apple-touch-icon`·`icon-maskable-512`)도 같은 3D 월렛으로
  생성했습니다(마스커블은 안전 영역 72% 스케일). `favicon-32.png`는 32px에서 뭉개져서
  기존 3선 마크를 유지합니다.

## 보안 모델

- 시드 문구/개인키는 **기기 localStorage에만** 존재하며, 평문으로 저장되지 않습니다.
- 저장 형식: `solwallet.vault.v1` = `{ v, alg:"AES-GCM", kdf:"PBKDF2-SHA256", iter:210000, salt, iv, ct }`
- 키 파생: 6자리 PIN + 랜덤 16바이트 salt → PBKDF2-SHA256 210,000회 → AES-256-GCM.
- 잠금 해제 시에만 메모리에 Keypair를 만들고, 잠그면 즉시 버립니다. 자동 잠금 기본 5분.
- 서버·백엔드가 없습니다. 모든 RPC/시세 호출은 브라우저에서 공개 API로 나갑니다.
- WebCrypto는 **보안 컨텍스트**에서만 동작하므로 HTTPS(또는 localhost)에서 열어야 합니다.
  HTTP LAN 주소로 열면 앱이 안내 화면을 보여 줍니다.

## 네트워크

- Mainnet: `https://api.mainnet-beta.solana.com` → 실패 시 `solana-rpc.publicnode.com`
  등으로 자동 재시도. 설정에서 Helius/QuickNode 같은 개인 RPC를 넣는 것이 가장 안정적입니다.
- Devnet: `https://api.devnet.solana.com`
- 설정 → 네트워크에서 전환, RPC 입력 후 저장. Devnet 주소/링크는 Solscan `?cluster=devnet`으로 연결됩니다.

> 참고: 솔라나 재단 공개 RPC는 브라우저(Origin 헤더가 붙는 요청)를 403으로 막는 경우가 있고,
> 일부 공개 미러는 `getTokenAccountsByOwner`를 제한합니다. 그래서 RPC 폴백과 "토큰 목록을
> 조회할 수 없습니다" 안내를 넣었습니다. 개인 RPC를 넣으면 두 문제가 모두 사라집니다.

## 바로 열기 (GitHub Pages)

- 라이브: **https://cbalhub.github.io/sol-wallet/**
- 저장소: https://github.com/Cbalhub/sol-wallet
- iPhone Safari에서 위 주소를 열고 공유 → **홈 화면에 추가**.

GitHub Pages는 `/sol-wallet/` 하위 경로로 서빙되므로 `vite.config.ts`의 `base`가
`/sol-wallet/`로 고정되어 있습니다. 사이트는 `main` 브랜치 빌드 결과를 `gh-pages`
브랜치 루트에 올리는 방식으로 배포합니다.

```bash
npm run build
cd dist && git init -q && git add -A && git commit -qm "deploy $(date +%F)"
git push -f https://github.com/Cbalhub/sol-wallet.git HEAD:gh-pages
```

## iPhone에 설치

PWA 설치와 WebCrypto 모두 HTTPS가 필요합니다.

1. `npm run build` 후 `dist/`를 정적 호스팅에 올립니다.
   - GitHub Pages: 위 라이브 주소 (이미 배포됨)
   - Vercel: `npx vercel deploy --prod` (프로젝트 루트에서)
   - Netlify: `dist` 폴더를 drag & drop
2. iPhone Safari에서 그 https 주소를 엽니다.
3. 공유 → **홈 화면에 추가**. 이후 아이콘으로 실행하면 상태바·노치·홈 인디케이터 safe-area가
   적용된 전체화면 앱으로 뜹니다.

로컬 개발 중 아이폰에서 보려면 HTTPS 터널이 필요합니다(`npx localtunnel --port 5173` 등).
HTTP LAN 주소는 암호화 API가 없어 동작하지 않습니다.

## 스크린샷

| 파일 | 내용 |
| --- | --- |
| `01-onboarding.png` | 온보딩 |
| `02-home.png` | 홈(새 지갑, Devnet) |
| `02b-home-funded.png` | 홈(실제 잔액·토큰 — 공개 Devnet 테스트 지갑) |
| `03-send.png` / `03b-send-filled.png` | 보내기 시트 |
| `07-send-confirm.png` | 전송 확인 단계 |
| `04-receive.png` | 받기 QR |
| `05-seed.png` / `05b-import.png` / `06-pin.png` | 시드 백업·가져오기·PIN 설정 |
| `09-activity.png` / `09b-activity-empty.png` | 활동 |
| `10-settings.png` | 설정 |
| `11-lock.png` / `11b-lock-error.png` | 잠금 / 잘못된 PIN |
| `12-backup.png` | PIN 확인 후 시드 문구 보기 |
| `13-mainnet-rpc-blocked.png` | 공개 RPC 차단 시 메인넷 상태 |

## 검증 기록

- `npm run build` — TypeScript 0 errors, Vite 빌드 성공 (gzip ~242 kB)
- 파생 경로: `abandon … about` → `HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk`,
  `test … junk` → `oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96` (ed25519-hd-key + tweetnacl
  교차검증 일치)
- 금고: 암호문에 시드 미포함, 정상 PIN 복호화 성공, 오류 PIN은 `InvalidPinError`
- 전송 코드: SOL(SystemProgram) / SPL(ATA 생성 포함) 트랜잭션 생성·서명 검증 통과
- UI: 390×844 모바일 뷰포트에서 생성·PIN·잠금/해제·Devnet 전환·송금/받기 시트·거래내역 확인
- 3D 클레이: `mix-blend-multiply` 적용 후 온보딩 히어로 주변·SOL 아이콘 원형 배경 픽셀이
  모두 `#FFFFFF` / `#F5F6F8`과 정확히 일치(사각 박스·회색 사각 테두리 0). 375×667·390×844·
  430×932 세 뷰포트에서 스크롤 오버플로우 없음(`scrollHeight == innerHeight`).
- 에셋 렌더 크기: 히어로 164px 박스(오브제 ≈123px, 원본 600px), SOL 코인 40px·52px(원본 240px).
  PNG 용량은 히어로 180KB · 코인 39KB.
