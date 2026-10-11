// Compiles Tailwind CSS at build time so the portals no longer load the runtime
// CDN play script. Scans every portal page and the precompiled bundles in public/built.
module.exports = {
  content: [
    './public/*.html',
    './public/driver/*.html',
    './public/built/*.js',
    './public/driver/app.js',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        vaayu: {
          50: '#ecfdf5',
          100: '#d1fae5',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
          glow: '#00f5a0',
        },
        swiggy: '#fc8019',
        blinkit: '#f8cb46',
        porter: '#2563eb',
        darkslate: '#0b1120',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Outfit', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
