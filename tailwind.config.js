/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pure white canvas, matte ink for anything that carries weight.
        base: '#FFFFFF',
        surface: '#F5F6F8',
        surface2: '#F2F4F6',
        ink: '#0D0E12',
        ink2: '#3E434D',
        muted: '#8B95A1',
        line: '#EFF1F4',
        accent: '#0D0E12',
        accentSoft: '#F5F6F8',
        mint: '#16A34A',
        mintSoft: '#EDF7F1',
        danger: '#EF4444',
        dangerSoft: '#FEF2F2',
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
