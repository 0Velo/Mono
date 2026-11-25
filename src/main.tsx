import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WalletProvider } from './state/WalletProvider'
import { applyTheme, watchSystemTheme } from './lib/theme'
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

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
