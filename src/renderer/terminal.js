// xterm and FitAddon are loaded via script tags in terminal.html
// Terminal is available as window.Terminal
// FitAddon is available as window.FitAddon.FitAddon

// Initialize terminal
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
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
  },
  allowTransparency: false,
  scrollback: 10000
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

// Send user input to main process
terminal.onData(data => {
  window.electronAPI.sendInput(data);
});

// Receive output from main process
window.electronAPI.onData(data => {
  terminal.write(data);
});

// Handle copy with Cmd+C when there's a selection
terminal.attachCustomKeyEventHandler((e) => {
  // Cmd+C with selection = copy
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && terminal.hasSelection()) {
    const selection = terminal.getSelection();
    navigator.clipboard.writeText(selection);
    terminal.clearSelection();
    return false; // Prevent sending Ctrl+C to terminal
  }

  // Cmd+V = paste
  if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
    navigator.clipboard.readText().then(text => {
      window.electronAPI.sendInput(text);
    });
    return false;
  }

  // Cmd+K = clear terminal
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    terminal.clear();
    return false;
  }

  return true; // Allow other keys through
});

// Focus terminal on load
terminal.focus();
