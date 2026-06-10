/**
 * Design Tokens - Single source of truth for the Cross AI Browser design system
 *
 * This file is consumed by:
 * - Electron app: via src/renderer/design-system.js (runtime CSS variable injection)
 * - PWA: via pwa/tailwind.config.js (build-time theme generation)
 */

const tokens = {
  colors: {
    // Background colors - neutral with subtle blue hint
    bg: {
      base: '#1a1a20',        // Darkest - app background
      surface: '#1f1f24',     // Panels, sidebars
      elevated: '#252530',    // Elevated surfaces, modals
      card: '#2a2a32',        // Cards, interactive elements
      cardHover: '#32323c',   // Card hover state
      input: '#1e1e24',       // Input fields
    },

    // Border colors - crisp, visible
    border: {
      subtle: '#333338',      // Subtle dividers
      default: '#3c3c42',     // Default borders
      hover: '#4a4a52',       // Hover state borders
      focus: '#6366f1',       // Focus rings
    },

    // Text colors
    text: {
      primary: 'rgba(255, 255, 255, 0.9)',
      secondary: 'rgba(255, 255, 255, 0.7)',
      muted: 'rgba(255, 255, 255, 0.5)',
      disabled: 'rgba(255, 255, 255, 0.3)',
    },

    // Primary accent - indigo (unified across Mac + PWA)
    primary: {
      base: '#6366f1',
      hover: '#5558e3',
      active: '#4f46e5',
      muted: 'rgba(99, 102, 241, 0.15)',
      border: 'rgba(99, 102, 241, 0.4)',
    },

    // Status colors
    status: {
      success: '#22c55e',
      successMuted: 'rgba(34, 197, 94, 0.15)',
      warning: '#fbbf24',
      warningMuted: 'rgba(251, 191, 36, 0.15)',
      error: '#ef4444',
      errorMuted: 'rgba(239, 68, 68, 0.15)',
      info: '#3b82f6',
      infoMuted: 'rgba(59, 130, 246, 0.15)',
    },

    // Service brand colors
    service: {
      chatgpt: '#10a37f',
      claude: '#d97757',
      gemini: '#8ab4f8',
      claudeCode: '#22c55e',
    },

    // Semantic colors for prompt library
    semantic: {
      reusable: '#10b981',      // Emerald for reusable prompts
      reusableMuted: 'rgba(16, 185, 129, 0.15)',
      favorite: '#fbbf24',      // Amber for favorites
      favoriteMuted: 'rgba(251, 191, 36, 0.15)',
      testing: '#eab308',       // Yellow for testing
      testingMuted: 'rgba(234, 179, 8, 0.15)',
      testingBg: 'linear-gradient(135deg, #2a2a00 0%, #252500 100%)',
      done: 'rgba(255, 255, 255, 0.4)',
      project: '#60a5fa',       // Blue for project scope
    },

    // Ready indicator (pulsing border when terminal awaits input)
    ready: {
      border: 'rgba(34, 197, 94, 1)',
      borderDim: 'rgba(34, 197, 94, 0.5)',
      glow: 'rgba(34, 197, 94, 0.5)',
      glowFar: 'rgba(34, 197, 94, 0.25)',
      glowDim: 'rgba(34, 197, 94, 0.25)',
      glowDimFar: 'rgba(34, 197, 94, 0.15)',
    },

    // Label colors - distinct colors with good contrast for white text
    // Used for prompt library labels, each label gets assigned a color
    label: {
      // Array of background colors for labels (cycle through)
      colors: [
        '#6366f1',  // Indigo
        '#8b5cf6',  // Violet
        '#d946ef',  // Fuchsia
        '#ec4899',  // Pink
        '#f43f5e',  // Rose
        '#ef4444',  // Red
        '#f97316',  // Orange
        '#eab308',  // Yellow (uses dark text)
        '#22c55e',  // Green
        '#14b8a6',  // Teal
        '#06b6d4',  // Cyan
        '#3b82f6',  // Blue
      ],
      // Text colors for each background (white except for yellow)
      textColors: [
        '#ffffff',  // Indigo - white
        '#ffffff',  // Violet - white
        '#ffffff',  // Fuchsia - white
        '#ffffff',  // Pink - white
        '#ffffff',  // Rose - white
        '#ffffff',  // Red - white
        '#ffffff',  // Orange - white
        '#1a1a20',  // Yellow - dark text for contrast
        '#ffffff',  // Green - white
        '#ffffff',  // Teal - white
        '#1a1a20',  // Cyan - dark text for better contrast
        '#ffffff',  // Blue - white
      ],
    },
  },

  // Spacing scale (4px base)
  spacing: {
    0: '0',
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '20px',
    6: '24px',
    8: '32px',
    10: '40px',
    12: '48px',
  },

  // Border radius
  radius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
    full: '9999px',
  },

  // Typography
  typography: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontFamilyMono: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: {
      xs: '10px',
      sm: '11px',
      base: '13px',
      md: '14px',
      lg: '16px',
      xl: '18px',
    },
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      tight: '1.2',
      normal: '1.5',
      relaxed: '1.75',
    },
    letterSpacing: {
      tight: '-0.01em',
      normal: '0',
      wide: '0.5px',
    },
  },

  // Shadows
  shadows: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
    md: '0 4px 6px rgba(0, 0, 0, 0.4)',
    lg: '0 10px 15px rgba(0, 0, 0, 0.5)',
    glow: '0 0 20px rgba(99, 102, 241, 0.3)',
    glowReady: '0 0 30px rgba(99, 102, 241, 0.5)',
  },

  // Transitions
  transitions: {
    fast: '150ms ease',
    normal: '200ms ease',
    slow: '300ms ease',
    pulse: '2.5s ease-in-out infinite',
  },

  // Z-index scale
  zIndex: {
    dropdown: '100',
    modal: '200',
    tooltip: '300',
    toast: '400',
  },
};

/**
 * Generate CSS custom properties from tokens
 * Used by Electron app for runtime injection
 */
function generateCSSVariables(tokens) {
  const lines = [':root {'];

  // Colors - flatten nested objects
  function addColorVars(obj, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const varName = prefix ? `${prefix}-${key}` : key;
      // Handle arrays (like label colors) - create indexed variables
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          lines.push(`  --color-${varName}-${index}: ${item};`);
        });
      }
      // Recurse into nested objects, but not null or arrays
      else if (typeof value === 'object' && value !== null) {
        addColorVars(value, varName);
      } else {
        lines.push(`  --color-${varName}: ${value};`);
      }
    }
  }
  addColorVars(tokens.colors);

  // Spacing
  for (const [key, value] of Object.entries(tokens.spacing)) {
    lines.push(`  --spacing-${key}: ${value};`);
  }

  // Radius
  for (const [key, value] of Object.entries(tokens.radius)) {
    lines.push(`  --radius-${key}: ${value};`);
  }

  // Typography
  lines.push(`  --font-family: ${tokens.typography.fontFamily};`);
  lines.push(`  --font-mono: ${tokens.typography.fontFamilyMono};`);
  for (const [key, value] of Object.entries(tokens.typography.fontSize)) {
    lines.push(`  --font-size-${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(tokens.typography.fontWeight)) {
    lines.push(`  --font-weight-${key}: ${value};`);
  }

  // Shadows
  for (const [key, value] of Object.entries(tokens.shadows)) {
    lines.push(`  --shadow-${key}: ${value};`);
  }

  // Transitions
  for (const [key, value] of Object.entries(tokens.transitions)) {
    lines.push(`  --transition-${key}: ${value};`);
  }

  lines.push('}');

  // Add ready indicator animation
  lines.push(`
@keyframes ready-pulse {
  0%, 100% {
    border-color: var(--color-ready-border);
    box-shadow: 0 0 20px var(--color-ready-glow);
  }
  50% {
    border-color: var(--color-primary-base);
    box-shadow: 0 0 35px var(--color-ready-glowIntense);
  }
}

.ready-indicator {
  border: 4px solid var(--color-ready-border);
  animation: ready-pulse 2.5s ease-in-out infinite;
}

.ready-indicator.inactive {
  border-color: transparent;
  box-shadow: none;
  animation: none;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
`);

  return lines.join('\n');
}

/**
 * Generate Tailwind theme extension from tokens
 * Used by PWA tailwind.config.js
 */
function generateTailwindTheme(tokens) {
  return {
    colors: {
      'app-bg': tokens.colors.bg.base,
      'app-surface': tokens.colors.bg.surface,
      'app-elevated': tokens.colors.bg.elevated,
      'app-card': tokens.colors.bg.card,
      'app-card-hover': tokens.colors.bg.cardHover,
      'app-input': tokens.colors.bg.input,
      'app-border': tokens.colors.border.default,
      'app-border-subtle': tokens.colors.border.subtle,
      'app-border-hover': tokens.colors.border.hover,
      'app-text': tokens.colors.text.primary,
      'app-text-secondary': tokens.colors.text.secondary,
      'app-text-muted': tokens.colors.text.muted,
      'app-accent': tokens.colors.primary.base,
      'app-accent-hover': tokens.colors.primary.hover,
      'app-accent-muted': tokens.colors.primary.muted,
      'app-success': tokens.colors.status.success,
      'app-warning': tokens.colors.status.warning,
      'app-error': tokens.colors.status.error,
      'app-reusable': tokens.colors.semantic.reusable,
      'app-favorite': tokens.colors.semantic.favorite,
      'app-testing': tokens.colors.semantic.testing,
      'app-project': tokens.colors.semantic.project,
    },
    fontFamily: {
      sans: tokens.typography.fontFamily,
    },
    fontSize: {
      'xs': tokens.typography.fontSize.xs,
      'sm': tokens.typography.fontSize.sm,
      'base': tokens.typography.fontSize.base,
      'md': tokens.typography.fontSize.md,
      'lg': tokens.typography.fontSize.lg,
      'xl': tokens.typography.fontSize.xl,
    },
    borderRadius: {
      'sm': tokens.radius.sm,
      'md': tokens.radius.md,
      'lg': tokens.radius.lg,
      'xl': tokens.radius.xl,
      'full': tokens.radius.full,
    },
    boxShadow: {
      'sm': tokens.shadows.sm,
      'md': tokens.shadows.md,
      'lg': tokens.shadows.lg,
      'glow': tokens.shadows.glow,
    },
  };
}

// Export for both CommonJS (Electron) and ESM (PWA)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tokens, generateCSSVariables, generateTailwindTheme };
}

export { tokens, generateCSSVariables, generateTailwindTheme };
