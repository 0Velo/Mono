/**
 * On-chain token safety check.
 *
 * A wallet cannot promise a token is "safe", but two facts are free to read
 * from the mint account and answer most of the question people actually have:
 *
 *  - **Mint authority** — if it still exists, the issuer can print more supply
 *    and dilute holders at will.
 *  - **Freeze authority** — if it still exists, the issuer can freeze your
 *    token account so it cannot be moved.
 *
 * Token-2022 mints can also carry extensions that change how a token behaves
 * (transfer fees, permanent delegate, transfer hooks, default-frozen accounts).
 * They are surfaced verbatim instead of being interpreted as a verdict.
 */
import { Connection, PublicKey } from '@solana/web3.js'

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

export interface TokenSecurity {
  mint: string
  program: string
  standard: 'spl-token' | 'token-2022' | 'unknown'
  mintAuthority: string | null
  freezeAuthority: string | null
  decimals: number | null
  supply: string | null
  extensions: string[]
  fetchedAt: number
}

/** Extensions that materially change what a holder can do with the token. */
const RISKY_EXTENSIONS: Record<string, string> = {
  transferFeeConfig: '전송 수수료',
  permanentDelegate: '영구 위임 권한',
  transferHook: '전송 훅',
  defaultAccountState: '기본 계정 상태',
  mintCloseAuthority: '민트 계정 폐쇄 권한',
  confidentialTransferMint: '기밀 전송',
  confidentialTransferFeeConfig: '기밀 전송 수수료',
  nonTransferable: '양도 불가',
  interestBearingConfig: '이자 표시',
  pausableConfig: '일시정지 권한',
}

function labelExtension(raw: string): string {
  return RISKY_EXTENSIONS[raw] ?? raw
}

export async function fetchTokenSecurity(
  connection: Connection,
  mint: string,
): Promise<TokenSecurity> {
  const key = new PublicKey(mint)
  const response = await connection.getParsedAccountInfo(key)
  const value = response.value
  if (!value) throw new Error('민트 계정을 찾을 수 없습니다.')

  const program = value.owner.toBase58()
  const data: any = value.data
  const info: any = data && typeof data === 'object' && 'parsed' in data ? data.parsed?.info : null

  const extensions: string[] = []
  if (Array.isArray(info?.extensions)) {
    for (const item of info.extensions) {
      const name = typeof item?.extension === 'string' ? item.extension : ''
      if (name) extensions.push(labelExtension(name))
    }
  }

  const standard: TokenSecurity['standard'] =
    program === TOKEN_PROGRAM ? 'spl-token' : program === TOKEN_2022_PROGRAM ? 'token-2022' : 'unknown'

  return {
    mint,
    program,
    standard,
    mintAuthority: typeof info?.mintAuthority === 'string' ? info.mintAuthority : null,
    freezeAuthority: typeof info?.freezeAuthority === 'string' ? info.freezeAuthority : null,
    decimals: typeof info?.decimals === 'number' ? info.decimals : null,
    supply: typeof info?.supply === 'string' ? info.supply : null,
    extensions: Array.from(new Set(extensions)),
    fetchedAt: Date.now(),
  }
}

export const SECURITY_DISCLAIMER =
  '이 정보는 민트 계정에서 읽은 참고 값이며, 안전을 보장하지 않습니다. 투자 판단의 근거로만 쓰지 마세요.'
