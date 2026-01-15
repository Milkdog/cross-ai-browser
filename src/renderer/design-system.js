/**
 * Design System - Runtime CSS Variable Injection for Electron
 *
 * This module imports design tokens and injects them as CSS custom properties.
 * Import this in any HTML file that needs access to the design system.
 */

import { tokens, generateCSSVariables } from '../../design-tokens.js';

// Generate and inject CSS variables
function initDesignSystem() {
  const cssText = generateCSSVariables(tokens);

  // Create or update the design system style element
  let styleEl = document.getElementById('design-system-vars');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'design-system-vars';
    document.head.insertBefore(styleEl, document.head.firstChild);
  }
  styleEl.textContent = cssText;
}

// Initialize immediately
initDesignSystem();

// Export tokens for JS access if needed
export { tokens };
