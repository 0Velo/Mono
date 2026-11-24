import { ArrowLeftRight, History, Settings2, Wallet } from 'lucide-react'

/**
 * What the person sees for the frame or two between entering the PIN and the
 * wallet chunk finishing. It mirrors the real layout so nothing jumps.
 */
export function ShellSkeleton() {
  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-[430px] flex-col bg-base">
      <div className="flex flex-1 flex-col pb-[86px]">
        <div
          className="flex items-center justify-between px-5"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 14px)' }}
        >
          <div className="skeleton h-[18px] w-[62px] rounded-md" />
          <div className="skeleton h-[18px] w-[70px] rounded-full" />
        </div>

        <div className="px-5 pt-11">
          <div className="skeleton h-[13px] w-[48px] rounded" />
          <div className="mt-3 skeleton h-[42px] w-[212px] rounded-[12px]" />
          <div className="mt-3 skeleton h-[13px] w-[120px] rounded" />
          <div className="mt-5 skeleton h-[40px] w-full rounded-[12px] opacity-60" />
        </div>

        <div className="mt-7 grid grid-cols-2 gap-2.5 px-5">
          <div className="skeleton h-[54px] rounded-full opacity-70" />
          <div className="skeleton h-[54px] rounded-full opacity-70" />
        </div>

        <div className="mt-10 space-y-5 px-5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3.5">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-3 w-[76px] rounded" />
                <div className="skeleton h-2.5 w-[48px] rounded" />
              </div>
              <div className="skeleton h-3 w-[56px] rounded" />
            </div>
          ))}
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[430px] border-t border-line bg-card/95 backdrop-blur-xl">
        <div className="safe-bottom flex items-stretch px-3">
          {[
            { label: '지갑', icon: Wallet, active: true },
            { label: '스왑', icon: ArrowLeftRight, active: false },
            { label: '활동', icon: History, active: false },
            { label: '설정', icon: Settings2, active: false },
          ].map((item) => (
            <div key={item.label} className="flex flex-1 flex-col items-center gap-[5px] pb-2 pt-2.5">
              <item.icon
                size={21}
                strokeWidth={item.active ? 2.1 : 1.7}
                className={item.active ? 'text-ink' : 'text-faint2'}
              />
              <span
                className={
                  item.active
                    ? 'text-[10.5px] font-semibold text-ink'
                    : 'text-[10.5px] font-medium text-faint2'
                }
              >
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}
