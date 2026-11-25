# Mono 백그라운드 Web Push 서버 (Vercel)

Mono 지갑이 앱을 닫아 둔 동안에도 입금을 알려 주기 위한 **작은 푸시 서버**입니다.
브라우저 앱(`../src`)이 요구하는 계약을 그대로 구현하며, 배포는 **이 디렉터리만**
Vercel 프로젝트로 올립니다(Root Directory: `push-server`). 정적 사이트(`gh-pages`)와
충돌하지 않습니다.

- 런타임: Vercel **Edge Functions** (`api/`)
- 저장소: **Neon Postgres** (Vercel Storage에서 프로비저닝한 `mono-push-db`, 무료 플랜)
- 감시: Solana 공개 RPC만 사용(유료 API 키 없음), Vercel Cron(하루 1회) + GitHub Actions(15분)
- 지갑 키·시드는 절대 받지 않습니다. 계정 연결 증명은 잠금 해제 중에 지갑이 만든 Ed25519 서명 한 번뿐입니다.

## 공개 API (브라우저가 호출)

모든 응답은 `Cache-Control: no-store`, CORS는 `APP_ORIGIN` 하나에만 열립니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/v1/config` | `{ "vapidPublicKey": "<base64url P-256 공개키 65바이트>" }` |
| `POST` | `/v1/subscriptions` | 구독 등록/갱신. 최초 `201 {"id"}`, 갱신 `200 {"id"}` |
| `DELETE` | `/v1/subscriptions/{id}` | `{"managementToken"}` 로 해지. 성공 `200 {"disabled":true}` |
| `OPTIONS` | 위 경로 | `APP_ORIGIN`에 대한 프리플라이트만 허용 |

`{id}`는 구독 endpoint의 소문자 SHA-256 hex(64자)입니다.

등록 본문(클라이언트 `src/lib/pushSubscriptions.ts`와 동일):

```json
{
  "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } },
  "address": "<base58 Solana 주소>",
  "network": "mainnet-beta" | "devnet",
  "managementToken": "<32바이트 base64url>",
  "issuedAt": "<10자리 Unix 초>",
  "signature": "<Ed25519 base64url>"
}
```

서명 대상(UTF-8, LF 구분, 끝 개행 없음):

```text
MONO-PUSH-V1
${address}
${network}
${issuedAt}
${sha256hex(endpoint)}
${sha256hex(managementToken)}
```

`issuedAt`은 서버 시각과 5분 이내여야 하고, 같은 endpoint를 다시 등록할 때는 **같은
managementToken**의 해시가 일치해야 합니다(다르면 `409`). 서버는 토큰 원문을 저장하지
않고 SHA-256 해시만 보관합니다.

푸시 endpoint는 벤더 허용 목록만 받습니다: `fcm.googleapis.com`,
`webpush.googleapis.com`, `web.push.apple.com`, `*.push.services.mozilla.com`,
`*.notify.windows.com`.

## 감시 경로

`GET|POST /api/cron/scan` — `Authorization: Bearer $CRON_SECRET` 필요.

- Vercel Cron: `vercel.json`의 `crons`가 하루 1회 호출합니다(Hobby 플랜의 최소 주기).
  Vercel은 `CRON_SECRET`이 설정돼 있으면 이 헤더를 자동으로 붙입니다.
- GitHub Actions `.github/workflows/push-scan.yml`: 15분마다 같은 엔드포인트를 호출합니다
  (public 저장소는 Actions 시간이 무료). `CRON_SECRET` 저장소 시크릿이 필요합니다.

스캔 1회는 최대 3개 구독을 순환 처리하고, 구독당 Solana RPC 호출을 최대 12회로 묶습니다
(전체 상한 50회). 첫 스캔은 기존 서명을 조용한 기준선으로만 저장하고 알림을 보내지
않습니다. 알림에는 정확한 금액을 넣지 않습니다.

## 환경변수 (Vercel 프로젝트 → Settings → Environment Variables)

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `APP_ORIGIN` | ✅ | `https://0velo.github.io` (경로가 아니라 **origin**) |
| `VAPID_PUBLIC_KEY` | ✅ | base64url 비압축 P-256 공개키(65바이트). 클라이언트로 공개되는 값 |
| `VAPID_PRIVATE_KEY` | ✅ | base64url PKCS#8 DER. **서버에만** 저장 |
| `VAPID_SUBJECT` | ✅ | `mailto:` 또는 `https://` 연락처 |
| `CRON_SECRET` | ✅ | 스캔 엔드포인트 인증 값(32바이트 이상 권장) |
| `DATABASE_URL` | 자동 | Neon 저장소를 프로젝트에 연결하면 주입됩니다 |

`DATABASE_URL`(또는 `POSTGRES_URL`)이 없으면 서버는 **실패 폐쇄**로 `503`을 돌려줍니다.

## 저장 구조

`mono_push_kv(key text primary key, value text, updated_at timestamptz)` 한 테이블.

- `sub/{id}` — 구독 레코드(endpoint, p256dh, auth, address, network, tokenDigest)
- `state/{id}` — 감시 커서(기준선 포함)
- `control/rotation` — 다음에 볼 구독 순번
- `control/daily-{YYYY-MM-DD}` — 일일 API 조작 소프트 상한(250)

테이블과 인덱스는 첫 요청 때 `CREATE TABLE IF NOT EXISTS`로 한 번만 만듭니다. 초기화가
필요하면 `DROP TABLE mono_push_kv;` 후 다음 요청에서 다시 만들어집니다.

## 로컬 확인

```sh
cd push-server
npm install
npm test        # 16개: 계약·CORS·서명검증·감시기준선·저장소 어댑터 (외부 호출 없음)
npm run check   # 문법 검사 + 위 테스트
```

## 남은 한계

- 저장소가 원자적 트랜잭션이 아닌 구간(구독 수 상한 확인, 일일 카운터)이 있어 동시
  요청에서 상한을 살짝 넘길 수 있습니다. **파일럿용 소프트 가드**입니다.
- 감시는 지갑 + 토큰 계정 최대 2개(프로그램별 1개)만 추적하고, 소스당 새 서명 2개까지만
  따라갑니다. 서명이 밀리면 그 스캔은 커서를 전진시키지 않고 실패합니다.
- 잔액 증가는 외부 입금의 완전한 의미 증명이 아닙니다(렌트 환급·계정 폐쇄 등도 증가로 보임).
- 푸시 전달 보장은 없습니다(중복·지연·누락 가능). 벤더가 404/410을 주면 해당 구독을
  수동으로 해지해야 합니다.
- Vercel Hobby Cron은 하루 1회이므로 실제 주기는 GitHub Actions가 만듭니다. 저장소에
  60일간 커밋이 없으면 GitHub가 예약 워크플로를 멈춥니다.
