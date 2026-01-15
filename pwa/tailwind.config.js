/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'app-bg': '#1e1e1e',
        'app-surface': '#252526',
        'app-border': '#3c3c3c',
        'app-text': '#d4d4d4',
        'app-text-muted': '#808080',
        'app-accent': '#d97757',
        'app-accent-hover': '#e88868',
      }
    },
  },
  plugins: [],
}
