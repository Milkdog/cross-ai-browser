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
  // Also update the page background to match
  document.body.style.background = theme.background;
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
  fitAddon.fit();
  const { cols, rows } = terminal;

  // Only proceed if we have valid dimensions (not too small)
  if (cols > 10 && rows > 5) {
    // Signal ready FIRST (only once), then send dimensions
    if (!hasSignaledReady) {
      hasSignaledReady = true;
      window.electronAPI.ready();
      console.log('Terminal ready, size:', cols, 'x', rows);
    }
    // Always send resize
    window.electronAPI.sendResize(cols, rows);
  }
}

// Multiple fit attempts to handle BrowserView bounds timing
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
  console.log('Claude process exited:', exitCode, signal);

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

// Usage bar update functionality
function updateUsageBar(type, data) {
  console.log('=== RENDERER: updateUsageBar called:', type, data);
  if (!data) return;

  const fillEl = document.getElementById(`${type}-fill`);
  const textEl = document.getElementById(`${type}-text`);

  console.log('=== RENDERER: DOM elements:', { fillEl: !!fillEl, textEl: !!textEl });
  if (!fillEl || !textEl) return;

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

  // Update text display
  const percentText = percentage > 0 ? `${Math.round(percentage)}%` : '--';
  const timeText = data.timeLeft || '--';
  textEl.textContent = `${percentText} \u2022 ${timeText}`;
}

// Listen for usage updates from main process
window.electronAPI.onUsageUpdate((data) => {
  console.log('=== RENDERER: Received usage update:', data);
  const { session, weekly } = data;
  updateUsageBar('session', session);
  updateUsageBar('weekly', weekly);
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
