import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Info, Share2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { showToast } from '../components/Toast'
import { networkDisplayName, type NetworkId } from '../lib/rpc'

interface ReceiveSheetProps {
  open: boolean
  onClose: () => void
  address: string
  network: NetworkId
}

export function ReceiveSheet({ open, onClose, address, network }: ReceiveSheetProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) setCopied(false)
  }, [open])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      showToast('주소를 복사했습니다')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      showToast('복사할 수 없습니다')
    }
  }

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Solana 주소', text: address })
        return
      } catch {
        /* user dismissed */
      }
    } else {
      void copy()
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="받기" subtitle={networkDisplayName(network)}>
      <div className="flex flex-col items-center pt-2">
        {/* 거래소 출금 화면에서 고르는 이름 그대로: 같은 체인의 다른 네트워크(BEP20·ERC20)와
            헷갈려 엉뚱한 곳으로 보내는 사고를 막는 한 줄. */}
        <div
          data-receive-network-hint
          className="mb-5 flex w-full items-start gap-2 rounded-[14px] bg-surface px-3.5 py-2.5 text-left"
        >
          <Info size={13} className="mt-[2px] shrink-0 text-ink" />
          <p className="text-[11px] leading-[1.55] text-ink2">
            {network === 'mainnet' ? (
              <>
                거래소 출금 시 반드시 <span className="font-semibold text-ink">Solana(SOL)</span> 네트워크 ·
                BEP20/ERC20 불가
              </>
            ) : (
              <>테스트 네트워크입니다 · 실제 자산을 보내면 사라집니다</>
            )}
          </p>
        </div>

        <div className="rounded-[28px] bg-surface p-4">
          <div className="rounded-[16px] bg-card p-3.5">
            <QRCodeSVG
              value={address}
              size={176}
              level="M"
              bgColor="#FFFFFF"
              fgColor="#0D0E12"
              marginSize={0}
            />
          </div>
        </div>

        <div className="mt-6 break-all px-2 text-center font-mono text-[12px] leading-[1.7] text-ink2">
          {address}
        </div>

        <div className="mt-7 grid w-full grid-cols-2 gap-2.5">
          <Button variant="secondary" onClick={copy}>
            {copied ? <Check size={16} className="text-mint" /> : <Copy size={16} />}
            {copied ? '복사됨' : '복사'}
          </Button>
          <Button onClick={share}>
            <Share2 size={16} /> 공유
          </Button>
        </div>

        <p className="mt-6 text-center text-[11.5px] leading-[1.7] text-faint">
          {network === 'mainnet' ? (
            'SOL과 SPL 토큰을 모두 받을 수 있습니다.'
          ) : (
            <>
              Devnet은 테스트 네트워크입니다.
              <br />
              실제 자산을 보내면 사라집니다.
            </>
          )}
        </p>
      </div>
    </Sheet>
  )
}
