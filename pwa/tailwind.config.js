/** @type {import('tailwindcss').Config} */
// Import design tokens from shared source
import { tokens, generateTailwindTheme } from '../design-tokens.js';

const designTheme = generateTailwindTheme(tokens);

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: designTheme.colors,
      fontFamily: designTheme.fontFamily,
      fontSize: designTheme.fontSize,
      borderRadius: designTheme.borderRadius,
      boxShadow: designTheme.boxShadow,
    },
  },
  plugins: [],
}
