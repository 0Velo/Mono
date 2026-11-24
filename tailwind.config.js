/** @type {import('tailwindcss').Config} */
const channel = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Every colour resolves through a CSS variable so one attribute on
        // <html> flips the whole app between the light and dark palette.
        base: channel('base'),
        card: channel('card'),
        surface: channel('surface'),
        surface2: channel('surface2'),
        ink: channel('ink'),
        ink2: channel('ink2'),
        muted: channel('muted'),
        faint: channel('faint'),
        faint2: channel('faint2'),
        line: channel('line'),
        line2: channel('line2'),
        press: channel('press'),
        press2: channel('press2'),
        mint: channel('mint'),
        mintSoft: channel('mint-soft'),
        danger: channel('danger'),
        dangerSoft: channel('danger-soft'),
        handle: channel('handle'),
        switch: channel('switch'),
        onInk: channel('on-ink'),
        warn: channel('warn'),
        accent: channel('ink'),
        accentSoft: channel('surface'),
      },
      fontFamily: {
        sans: [
          'Pretendard Variable',
          'Pretendard',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'sans-serif',
        ],
      },
      borderRadius: {
        xl2: '18px',
        xl3: '22px',
        xl4: '28px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(13, 14, 18, 0.03)',
        float: '0 -12px 40px -24px rgba(13, 14, 18, 0.28)',
        key: '0 0 0 0 transparent',
      },
    },
  },
  plugins: [],
}
