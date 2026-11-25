/**
 * 실행 중인 빌드가 배포된 빌드와 같은지 확인한다.
 *
 * 아이폰 홈 화면 앱은 백그라운드로 보낸 페이지를 메모리에 그대로 살려 둔다.
 * 그래서 새 빌드를 배포해도 앱을 다시 열었을 때 몇 시간~며칠 전 자바스크립트가
 * 그대로 돌아가는 일이 있다. 빌드마다 다른 id를 번들에 심고, 배포된
 * `version.json`과 비교해 "새 버전이 있다"는 것을 화면에서 알린다.
 */

/** 이 번들의 빌드 id. 개발 서버에서는 'dev'. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/** 배포된 빌드 id. 네트워크/형식 문제면 null(확인 불가). */
export async function fetchDeployedBuild(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
      cache: 'no-store',
    })
    if (!response.ok) return null
    const data = (await response.json()) as { build?: unknown }
    return typeof data?.build === 'string' && data.build ? data.build : null
  } catch {
    return null
  }
}

/** 배포된 빌드가 지금 실행 중인 빌드와 다르면 true. */
export function isNewerBuild(deployed: string | null): boolean {
  return Boolean(deployed) && deployed !== BUILD_ID
}
