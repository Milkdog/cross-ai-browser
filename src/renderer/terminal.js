// xterm and FitAddon are loaded via script tags in terminal.html
// Terminal is available as window.Terminal
// FitAddon is available as window.FitAddon.FitAddon

// Default theme (VS Code Dark) - used until saved theme is loaded
const defaultTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selection: 'rgba(99, 102, 241, 0.4)',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff'
};

// Initialize terminal with default theme
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: defaultTheme,
  allowTransparency: false,
  scrollback: 10000
});

// Expose focus function for prompt library
window.focusTerminal = () => {
  terminal.focus();
};

// Expose paste function for prompt library to trigger image paste
window.triggerPaste = async () => {
  // This replicates the Cmd+V paste logic from the key handler
  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      // Check for image types
      const imageType = item.types.find(type => type.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Save image to temp file and get path
        const result = await window.electronAPI.saveClipboardImage(Array.from(uint8Array));
        if (result.success) {
          // Send the file path to terminal for Claude to process
          window.electronAPI.sendInput(result.path);
          return true;
        }
      }
    }
    // No image found, fall back to text paste
    const text = await navigator.clipboard.readText();
    if (text) {
      window.electronAPI.sendInput(text);
      return true;
    }
  } catch (err) {
    console.error('triggerPaste failed:', err);
  }
  return false;
};

// Apply theme to terminal and update page background
function applyTheme(theme) {
  terminal.options.theme = theme;
  // Update page background and inactive border color to match terminal
  document.body.style.background = theme.background;
  const tc = document.getElementById('terminal-container');
  if (tc && !tc.classList.contains('ready-for-input')) {
    tc.style.borderColor = theme.background;
  }
  // Store for ready indicator dismiss
  tc?.dataset && (tc.dataset.themeBg = theme.background);
}

// Load saved theme from settings
async function loadSavedTheme() {
  try {
    const themeData = await window.electronAPI.getTerminalTheme();
    if (themeData && themeData.theme) {
      applyTheme(themeData.theme);
    }
  } catch (e) {
    console.error('Failed to load terminal theme:', e);
  }
}

// Load theme immediately
loadSavedTheme();

// Listen for theme changes from settings
window.electronAPI.onThemeChanged(async (themeId) => {
  try {
    const themeData = await window.electronAPI.getTerminalTheme();
    if (themeData && themeData.theme) {
      applyTheme(themeData.theme);
    }
  } catch (e) {
    console.error('Failed to apply theme change:', e);
  }
});

const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);

// Open terminal in container
const container = document.getElementById('terminal-container');
terminal.open(container);

// Fit terminal to container
let hasSignaledReady = false;

function fitTerminal() {
  // Use proposeDimensions to get the calculated size, then subtract
  // a safety margin to prevent text clipping at edges
  const dims = fitAddon.proposeDimensions();
  if (!dims) return;

  const cols = Math.max(2, dims.cols - 1);
  const rows = dims.rows;
  terminal.resize(cols, rows);

  // Only proceed if we have valid dimensions (not too small)
  if (cols > 10 && rows > 5) {
    // Signal ready FIRST (only once), then send dimensions
    if (!hasSignaledReady) {
      hasSignaledReady = true;
      window.electronAPI.ready();
    }
    // Always send resize
    window.electronAPI.sendResize(cols, rows);
  }
}

// Multiple fit attempts to handle WebContentsView bounds timing
function initializeFit() {
  // Try fitting at increasing intervals until we get valid size
  const delays = [50, 150, 300, 500, 1000];
  delays.forEach(delay => {
    setTimeout(fitTerminal, delay);
  });
}

initializeFit();

// Handle window resize
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitTerminal, 100);
});

// Track if user has intentionally scrolled away from bottom
let userScrolledUp = false;

// Send user input to main process
terminal.onData(data => {
  window.electronAPI.sendInput(data);
  // Reset scroll state when user sends input - they want to see the response
  userScrolledUp = false;
  terminal.scrollToBottom();
});

// Check if terminal is scrolled to bottom
function isAtBottom() {
  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const baseY = buffer.baseY;
  // At bottom if viewport is at or near the base (within 3 lines tolerance)
  return viewportY >= baseY - 3;
}

// Detect user scroll via wheel events on the terminal container
// This is more reliable than xterm's onScroll which doesn't distinguish sources
container.addEventListener('wheel', (e) => {
  // Scrolling up (negative deltaY) = user wants to read previous content
  if (e.deltaY < 0) {
    userScrolledUp = true;
  }
  // Scrolling down - check if we reached bottom after a short delay
  // (to let the scroll complete)
  if (e.deltaY > 0) {
    setTimeout(() => {
      if (isAtBottom()) {
        userScrolledUp = false;
      }
    }, 50);
  }
}, { passive: true });

// Also handle keyboard scrolling (Page Up/Down, etc.)
terminal.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown') {
    // Page Up or Shift+Page Up - user wants to scroll up
    if (e.key === 'PageUp') {
      userScrolledUp = true;
    }
    // Page Down - check if at bottom after scroll
    if (e.key === 'PageDown') {
      setTimeout(() => {
        if (isAtBottom()) {
          userScrolledUp = false;
        }
      }, 50);
    }
  }
  return true; // Don't block any keys here, let the other handler deal with copy/paste
});

// Receive output from main process
window.electronAPI.onData(data => {
  terminal.write(data);

  // Only auto-scroll if user hasn't scrolled up
  if (!userScrolledUp) {
    terminal.scrollToBottom();
  }
});

// Handle copy with Cmd+C when there's a selection
terminal.attachCustomKeyEventHandler((e) => {
  // Cmd+C with selection = copy (only on keydown)
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && e.type === 'keydown' && terminal.hasSelection()) {
    const selection = terminal.getSelection();
    navigator.clipboard.writeText(selection);
    terminal.clearSelection();
    return false; // Prevent sending Ctrl+C to terminal
  }

  // Cmd+V = paste (supports both text and images)
  // Only handle keydown to avoid double-paste (handler fires for both keydown and keyup)
  if ((e.metaKey || e.ctrlKey) && e.key === 'v' && e.type === 'keydown') {
    e.preventDefault(); // Prevent browser's native paste

    // Try to read clipboard items to check for images
    navigator.clipboard.read().then(async (clipboardItems) => {
      for (const item of clipboardItems) {
        // Check for image types
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (imageType) {
          try {
            const blob = await item.getType(imageType);
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            // Save image to temp file and get path
            const result = await window.electronAPI.saveClipboardImage(Array.from(uint8Array));
            if (result.success) {
              // Send the file path to terminal for Claude to process
              window.electronAPI.sendInput(result.path);
            } else {
              console.error('Failed to save clipboard image:', result.error);
            }
            return;
          } catch (err) {
            console.error('Error processing clipboard image:', err);
          }
        }
      }

      // No image found, fall back to text paste
      const text = await navigator.clipboard.readText();
      if (text) {
        window.electronAPI.sendInput(text);
      }
    }).catch((err) => {
      // Clipboard API not available or permission denied, fall back to text
      console.warn('Clipboard read failed, falling back to text:', err);
      navigator.clipboard.readText().then(text => {
        window.electronAPI.sendInput(text);
      }).catch(console.error);
    });

    return false;
  }

  // Cmd+K = clear terminal (only on keydown)
  if ((e.metaKey || e.ctrlKey) && e.key === 'k' && e.type === 'keydown') {
    terminal.clear();
    return false;
  }

  return true; // Allow other keys through
});

// Focus terminal on load
terminal.focus();

// Handle process exit - show reload/close options
window.electronAPI.onExit(({ exitCode, signal }) => {

  // Create exit overlay using safe DOM methods
  const overlay = document.createElement('div');
  overlay.id = 'exit-overlay';

  const message = document.createElement('div');
  message.className = 'exit-message';

  const icon = document.createElement('div');
  icon.className = 'exit-icon';
  icon.textContent = '⏹';

  const title = document.createElement('div');
  title.className = 'exit-title';
  title.textContent = 'Claude Code has exited';

  const buttons = document.createElement('div');
  buttons.className = 'exit-buttons';

  // Resume button (primary) - uses claude --continue
  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'exit-btn resume-btn';
  const resumeIcon = document.createElement('span');
  resumeIcon.className = 'btn-icon';
  resumeIcon.textContent = '▶';
  resumeBtn.appendChild(resumeIcon);
  resumeBtn.appendChild(document.createTextNode(' Resume'));

  // New Session button - starts fresh
  const newBtn = document.createElement('button');
  newBtn.className = 'exit-btn new-btn';
  const newIcon = document.createElement('span');
  newIcon.className = 'btn-icon';
  newIcon.textContent = '+';
  newBtn.appendChild(newIcon);
  newBtn.appendChild(document.createTextNode(' New Session'));

  // Close Tab button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'exit-btn close-btn';
  const closeIcon = document.createElement('span');
  closeIcon.className = 'btn-icon';
  closeIcon.textContent = '✕';
  closeBtn.appendChild(closeIcon);
  closeBtn.appendChild(document.createTextNode(' Close Tab'));

  buttons.appendChild(resumeBtn);
  buttons.appendChild(newBtn);
  buttons.appendChild(closeBtn);
  message.appendChild(icon);
  message.appendChild(title);
  message.appendChild(buttons);
  overlay.appendChild(message);

  // Style the overlay
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(30, 30, 30, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  const style = document.createElement('style');
  style.textContent = `
    .exit-message {
      text-align: center;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .exit-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.7;
    }
    .exit-title {
      font-size: 18px;
      font-weight: 500;
      margin-bottom: 24px;
    }
    .exit-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
    .exit-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .exit-btn:hover {
      transform: translateY(-1px);
    }
    .btn-icon {
      font-size: 16px;
    }
    .resume-btn {
      background: #d97757;
      color: white;
    }
    .resume-btn:hover {
      background: #e88868;
    }
    .new-btn {
      background: #3c3c3c;
      color: #d4d4d4;
    }
    .new-btn:hover {
      background: #4c4c4c;
    }
    .close-btn {
      background: #3c3c3c;
      color: #d4d4d4;
    }
    .close-btn:hover {
      background: #4c4c4c;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // Handle button clicks
  resumeBtn.addEventListener('click', () => {
    overlay.remove();
    terminal.clear();
    window.electronAPI.resume(); // Uses claude --continue
  });

  newBtn.addEventListener('click', () => {
    overlay.remove();
    terminal.clear();
    window.electronAPI.reload(); // Starts fresh claude session
  });

  closeBtn.addEventListener('click', () => {
    window.electronAPI.close();
  });
});

// Live countdown state \u2014 last payload from main caches percent + resetsAt,
// then a 1s tick recomputes the time-remaining string locally so the clock
// is realtime between server fetches.
const usageState = { session: null, weekly: null, extra: null };

function formatTimeRemainingMs(ms) {
  if (ms == null) return '--';
  if (ms <= 0) return 'now';
  const totalMins = Math.floor(ms / 60000);
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor(totalMins / 60) % 24;
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Usage bar update functionality
function updateUsageBar(type, data) {
  if (!data) return;

  const fillEl = document.getElementById(`${type}-fill`);
  const textEl = document.getElementById(`${type}-text`);
  const markerEl = document.getElementById(`${type}-time-marker`);

  if (!fillEl || !textEl) return;

  // Compute live values when we have resetsAt (overrides server-formatted strings)
  let timeText = data.timeLeft || '--';
  let timeElapsedPercent = data.timeElapsedPercent;
  if (data.resetsAt && data.windowMinutes) {
    const remainingMs = data.resetsAt - Date.now();
    timeText = formatTimeRemainingMs(remainingMs);
    if (remainingMs <= 0) {
      timeElapsedPercent = 100;
    } else {
      const windowMs = data.windowMinutes * 60 * 1000;
      const elapsed = ((windowMs - remainingMs) / windowMs) * 100;
      timeElapsedPercent = Math.max(0, Math.min(100, elapsed));
    }
  }

  // Update progress bar width
  const percentage = data.percentUsed || 0;
  fillEl.style.width = `${Math.min(percentage, 100)}%`;

  // Apply warning colors based on percentage
  fillEl.classList.remove('warning', 'critical');
  if (percentage >= 95) {
    fillEl.classList.add('critical');
  } else if (percentage >= 90) {
    fillEl.classList.add('warning');
  }

  // Update time-elapsed marker
  if (markerEl && timeElapsedPercent != null) {
    markerEl.style.left = `${timeElapsedPercent}%`;
    markerEl.classList.add('visible');
  } else if (markerEl) {
    markerEl.classList.remove('visible');
  }

  // Update text display
  const percentText = percentage > 0 ? `${Math.round(percentage)}%` : '--';
  textEl.textContent = `${percentText} \u2022 ${timeText}`;
}

// Fade the bars from full-strength (just-fetched) to a muted blue as the data
// ages over the 5-minute fetch interval. Resets to full strength when a new
// payload arrives. Track stays solid so bar length is still legible.
const USAGE_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_OPACITY_FRESH = 1.0;
const USAGE_OPACITY_STALE = 0.35;

function applyUsageFreshness() {
  if (!lastUsageFetchedAt) return;
  const age = Date.now() - lastUsageFetchedAt;
  const ratio = Math.max(0, Math.min(1, age / USAGE_FETCH_INTERVAL_MS));
  const opacity = USAGE_OPACITY_FRESH - (USAGE_OPACITY_FRESH - USAGE_OPACITY_STALE) * ratio;
  for (const id of ['session-fill', 'weekly-fill', 'extra-fill']) {
    const el = document.getElementById(id);
    if (el) el.style.opacity = opacity.toFixed(3);
  }
}

// Format a credit amount as localized currency, falling back to a plain "$" form.
function formatUsageCurrency(amount, currency) {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2
    }).format(amount);
  } catch (_) {
    return `$${Number(amount).toFixed(2)}`;
  }
}

// Show/hide and populate the Extra Usage chip. Hidden entirely unless the user
// has enabled pay-as-you-go credits; when enabled it highlights and shows the
// remaining budget.
function updateExtraUsage(extra) {
  const bar = document.getElementById('extra-usage-bar');
  if (!bar) return;

  if (!extra || !extra.enabled) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const fillEl = document.getElementById('extra-fill');
  const textEl = document.getElementById('extra-text');

  // The fill bar tracks overage utilization (how much of the monthly spend cap
  // has been used) when known; the prepaid balance has no natural 0-100 scale.
  if (fillEl) {
    fillEl.style.width = extra.utilization != null ? `${Math.min(extra.utilization, 100)}%` : '0%';
  }

  if (textEl) {
    // "Budget remaining" the user cares about is the prepaid credit balance,
    // not the overage cap. Prefer it; fall back to overage figures.
    const balance = extra.balance ? formatUsageCurrency(extra.balance.amount, extra.balance.currency) : null;
    const remaining = formatUsageCurrency(extra.remaining, extra.currency);
    const limit = formatUsageCurrency(extra.monthlyLimit, extra.currency);

    if (balance != null) {
      textEl.textContent = `${balance} left`;
      // Surface the overage cap/used detail on hover.
      if (remaining != null && limit != null) {
        textEl.title = `Prepaid balance. Overage: ${formatUsageCurrency(extra.usedCredits, extra.currency)} of ${limit} cap used`;
      } else {
        textEl.removeAttribute('title');
      }
    } else if (remaining != null && limit != null) {
      textEl.textContent = `${remaining} left of ${limit}`;
      textEl.removeAttribute('title');
    } else if (extra.utilization != null) {
      textEl.textContent = `${extra.utilization}% used`;
      textEl.removeAttribute('title');
    } else {
      textEl.textContent = 'enabled';
      textEl.removeAttribute('title');
    }
  }
}

// Tick once per second to keep the countdown text + elapsed marker + fade fresh.
setInterval(() => {
  if (usageState.session) updateUsageBar('session', usageState.session);
  if (usageState.weekly) updateUsageBar('weekly', usageState.weekly);
  applyUsageFreshness();
}, 1000);

// Freshness tracking
let lastUsageFetchedAt = null;
let lastUsageError = null;

function formatRelativeTime(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function refreshFreshnessIndicator() {
  const el = document.getElementById('usage-freshness');
  const tooltip = document.getElementById('usage-tooltip');
  if (!el || !tooltip) return;

  el.classList.remove('stale', 'error');

  if (lastUsageError && !lastUsageFetchedAt) {
    el.classList.add('error');
    tooltip.textContent = `Usage fetch failed: ${lastUsageError}`;
    return;
  }

  if (!lastUsageFetchedAt) {
    tooltip.textContent = 'Usage data not yet loaded — updates every 5 minutes';
    return;
  }

  const age = Date.now() - lastUsageFetchedAt;
  const relative = formatRelativeTime(age);

  if (lastUsageError) {
    el.classList.add('error');
    tooltip.textContent = `Last updated ${relative} — last refresh failed: ${lastUsageError}`;
  } else if (age > 10 * 60 * 1000) {
    el.classList.add('stale');
    tooltip.textContent = `Last updated ${relative} (stale) — updates every 5 minutes`;
  } else {
    tooltip.textContent = `Last updated ${relative} — updates every 5 minutes`;
  }
}

setInterval(refreshFreshnessIndicator, 5000);

// Listen for usage updates from main process
window.electronAPI.onUsageUpdate((data) => {
  if (!data) return;

  // Bare error with no data to fall back on — only then do we blank the bars.
  // (Main only sends this when no usage has ever been fetched successfully.)
  if (data.error && !data.session && !data.weekly) {
    console.error('[usage] fetch error:', data.error);
    lastUsageError = data.error;
    if (!lastUsageFetchedAt) {
      const sessionText = document.getElementById('session-text');
      const weeklyText = document.getElementById('weekly-text');
      if (sessionText) sessionText.textContent = 'usage api error';
      if (weeklyText) weeklyText.textContent = 'usage api error';
    }
    refreshFreshnessIndicator();
    return;
  }

  // Fresh data, or last-known-good carried with a `lastError` annotation when
  // the most recent refresh failed. Either way we render the values so the bars
  // never blank on a transient failure; the freshness indicator flags staleness.
  lastUsageError = data.lastError || null;
  if (data.fetchedAt) lastUsageFetchedAt = data.fetchedAt;

  const sessionText = document.getElementById('session-text');
  const weeklyText = document.getElementById('weekly-text');
  if (sessionText) sessionText.removeAttribute('title');
  if (weeklyText) weeklyText.removeAttribute('title');

  const { session, weekly, extra } = data;
  // Cache so the 1s tick keeps the countdown and elapsed marker live.
  // A new server payload fully replaces these — including resetsAt — so any
  // server-side correction propagates immediately.
  usageState.session = session || null;
  usageState.weekly = weekly || null;
  usageState.extra = extra || null;
  updateUsageBar('session', session);
  updateUsageBar('weekly', weekly);
  updateExtraUsage(extra);
  applyUsageFreshness();
  refreshFreshnessIndicator();
});

// Request initial usage data once terminal is ready
setTimeout(() => {
  window.electronAPI.requestUsageUpdate();
}, 1000);

// Initialize prompt library
const promptLibrary = new PromptLibrary();
promptLibrary.init();

// Refit terminal when container size changes (e.g., prompt panel toggle)
// Watch terminal-container, not terminal-layout (which has fixed 100% width)
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitTerminal, 50);
});

const terminalContainer = document.getElementById('terminal-container');
if (terminalContainer) {
  resizeObserver.observe(terminalContainer);
}

// Also refit after prompt panel transition ends (CSS transition is 200ms)
const promptPanel = document.getElementById('prompt-panel');
if (promptPanel) {
  promptPanel.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'width') {
      fitTerminal();
    }
  });
}

// ==================== Ready Indicator ====================
// Shows a pulsing border when terminal is awaiting user input
// Disappears when user interacts with the terminal
// Only reappears after Claude finishes responding (streaming stops)

let isStreaming = false;
let userInteracted = false;
let readyIndicatorTimeout = null;

function updateReadyIndicator() {
  const shouldShowReady = !isStreaming && !userInteracted;
  container.classList.toggle('ready-for-input', shouldShowReady);
  if (shouldShowReady) {
    // Clear inline style so CSS animation controls border-color
    container.style.borderColor = '';
  } else {
    // Restore border to theme background so it blends in
    const themeBg = container.dataset.themeBg;
    if (themeBg) container.style.borderColor = themeBg;
  }
}

function markUserInteraction() {
  userInteracted = true;
  clearTimeout(readyIndicatorTimeout); // Cancel any pending reset
  updateReadyIndicator();
}

// Detect user interaction - any of these dismisses the indicator
container.addEventListener('mouseenter', markUserInteraction);
container.addEventListener('click', markUserInteraction);
container.addEventListener('keydown', markUserInteraction);

// Listen for streaming state from main process
window.electronAPI.onStreamingState?.((streaming) => {
  const wasStreaming = isStreaming;
  isStreaming = streaming;

  if (streaming) {
    // Streaming started - hide ready indicator
    userInteracted = true;
    clearTimeout(readyIndicatorTimeout);
    updateReadyIndicator();
  } else if (wasStreaming) {
    // Streaming just stopped - show ready indicator after delay
    // This indicates Claude finished and is ready for new input
    clearTimeout(readyIndicatorTimeout);
    readyIndicatorTimeout = setTimeout(() => {
      userInteracted = false;
      updateReadyIndicator();
    }, 2000);
  }
});

// Initial state - show ready indicator after terminal loads
setTimeout(() => {
  updateReadyIndicator();
}, 3000);
