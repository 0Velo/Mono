import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Share2 } from 'lucide-react'
import { Sheet } from '../components/Sheet'
import { Button } from '../components/Button'
import { showToast } from '../components/Toast'
import type { NetworkId } from '../lib/rpc'

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
    <Sheet
      open={open}
      onClose={onClose}
      title="받기"
      subtitle={`Solana ${network === 'mainnet' ? 'Mainnet' : 'Devnet'}`}
    >
      <div className="flex flex-col items-center pt-2">
        <div className="rounded-[28px] bg-surface p-4">
          <div className="rounded-[16px] bg-white p-3.5">
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

        <p className="mt-6 text-center text-[11.5px] leading-[1.7] text-[#A9AFB9]">
          SOL과 SPL 토큰을 모두 받을 수 있습니다.
          <br />
          {network === 'mainnet'
            ? '다른 네트워크(이더리움, BNB 등)의 자산은 보내지 마세요.'
            : 'Devnet은 테스트 네트워크입니다. 실제 자산을 보내면 사라집니다.'}
        </p>
      </div>
    </Sheet>
  )
}
