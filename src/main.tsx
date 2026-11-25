import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WalletProvider } from './state/WalletProvider'
import { applyTheme, watchSystemTheme } from './lib/theme'
import { hideAppSplash } from './lib/splash'
import './assets/fonts/pretendard.css'
import './index.css'

// Paint the saved theme before the first React render so the app never opens
// in the wrong palette and then flips.
applyTheme()
watchSystemTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </React.StrictMode>,
)

// App hides the splash as soon as the vault is read. This is the safety net for
// the case where initialisation never finishes: the person must never be stuck
// looking at a logo.
window.setTimeout(hideAppSplash, 8000)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
