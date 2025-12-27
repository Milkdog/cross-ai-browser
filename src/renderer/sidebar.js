console.log('sidebar.js loaded');

// State
let activeDownloads = [];
let downloadHistory = [];
let historySessions = [];
let historyExpanded = false;
let tabsWithCompletions = new Set();
let streamingTabs = new Map(); // tabId -> { isStreaming, taskDescription }

// Service icons (duplicated from ServiceRegistry for renderer)
const SERVICE_ICONS = {
  chatgpt: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.6 8.3829l2.02-1.1638a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
  </svg>`,
  claude: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.603 15.401l2.76-6.952h.104l2.776 6.952h-1.14l-.637-1.669H6.364l-.62 1.669h-1.14zm2.4-2.622h1.664l-.817-2.2h-.031l-.816 2.2z"/>
    <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17z"/>
  </svg>`,
  gemini: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L9.19 9.19 2 12l7.19 2.81L12 22l2.81-7.19L22 12l-7.19-2.81L12 2z"/>
  </svg>`,
  'claude-code': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4 17 10 11 4 5"></polyline>
    <line x1="12" y1="19" x2="20" y2="19"></line>
  </svg>`
};

let activeTabId = null;
let allTabs = [];
let draggedTabId = null;

async function init() {
  console.log('init() called');

  // Load all tabs
  allTabs = await window.electronAPI.getAllTabs();
  console.log('tabs loaded:', allTabs);

  renderTabs(allTabs);

  // Set initial active state
  activeTabId = await window.electronAPI.getActiveService();
  updateActiveState(activeTabId);

  // Load initial downloads
  const initialDownloads = await window.electronAPI.getDownloads();
  activeDownloads = initialDownloads.active || [];
  downloadHistory = initialDownloads.history || [];
  renderDownloads();

  // Listen for active service changes
  window.electronAPI.onActiveServiceChanged((tabId) => {
    activeTabId = tabId;
    updateActiveState(tabId);
  });

  // Listen for tab updates
  window.electronAPI.onTabsUpdated((tabs) => {
    allTabs = tabs;
    renderTabs(tabs);
    updateActiveState(activeTabId);
  });

  // Listen for download updates
  window.electronAPI.onDownloadsUpdated((data) => {
    activeDownloads = data.active || [];
    downloadHistory = data.history || [];
    renderDownloads();
  });

  // Load initial history sessions
  historySessions = await window.electronAPI.getHistorySessions({ limit: 20 });
  renderHistory();

  // Listen for history updates
  window.electronAPI.onHistoryUpdated((data) => {
    historySessions = data.sessions || [];
    renderHistory();
  });

  // Load initial completion badges
  const initialBadges = await window.electronAPI.getCompletionBadges();
  tabsWithCompletions = new Set(initialBadges);
  renderTabs(allTabs);

  // Listen for completion badge updates
  window.electronAPI.onCompletionBadgesUpdated((tabIds) => {
    tabsWithCompletions = new Set(tabIds);
    renderTabs(allTabs);
  });

  // Listen for streaming state changes
  window.electronAPI.onStreamingStateChanged((data) => {
    const { tabId, isStreaming, taskDescription } = data;
    if (isStreaming) {
      streamingTabs.set(tabId, { isStreaming, taskDescription });
    } else {
      streamingTabs.delete(tabId);
    }
    renderTabs(allTabs);
  });

  // History panel toggle
  document.getElementById('history-header').addEventListener('click', () => {
    historyExpanded = !historyExpanded;
    const panel = document.getElementById('history-panel');
    const content = document.getElementById('history-content');
    panel.classList.toggle('expanded', historyExpanded);
    content.style.display = historyExpanded ? 'block' : 'none';
  });

  // Reload button
  document.getElementById('reload-btn').addEventListener('click', () => {
    if (activeTabId) {
      window.electronAPI.reloadService(activeTabId);
    }
  });

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', () => {
    window.electronAPI.openSettings();
  });

  // Add tab button
  document.getElementById('add-tab-btn').addEventListener('click', () => {
    window.electronAPI.showServicePicker();
  });
}

function renderTabs(tabs) {
  const container = document.getElementById('service-buttons');
  container.textContent = ''; // Clear safely

  tabs.forEach((tab, index) => {
    const btn = document.createElement('button');
    btn.className = 'service-btn';
    btn.dataset.tabId = tab.id;
    btn.dataset.serviceType = tab.serviceType;
    btn.dataset.type = tab.type;
    btn.draggable = true;

    if (tab.shortcut) {
      btn.dataset.shortcut = tab.shortcut;
      btn.title = `${tab.name} (${tab.shortcut})`;
    } else {
      btn.title = tab.name;
    }

    // Create icon container
    const iconDiv = document.createElement('div');
    iconDiv.className = 'service-icon';

    // Use template for safe SVG insertion
    const template = document.createElement('template');
    template.innerHTML = (SERVICE_ICONS[tab.serviceType] || '').trim();
    if (template.content.firstChild) {
      iconDiv.appendChild(template.content.cloneNode(true));
    }

    btn.appendChild(iconDiv);

    // Create text container for name and optional task description
    const textContainer = document.createElement('div');
    textContainer.className = 'tab-text';

    // Add name label for all tabs
    const nameLabel = document.createElement('div');
    nameLabel.className = 'tab-name';
    nameLabel.textContent = tab.name;
    textContainer.appendChild(nameLabel);

    // Check if this tab is streaming
    const streamingState = streamingTabs.get(tab.id);
    if (streamingState && streamingState.isStreaming) {
      btn.classList.add('is-streaming');

      // Add task description if available
      if (streamingState.taskDescription) {
        const taskLabel = document.createElement('div');
        taskLabel.className = 'tab-task';
        taskLabel.textContent = streamingState.taskDescription;
        taskLabel.title = streamingState.taskDescription;
        textContainer.appendChild(taskLabel);
      }
    }

    btn.appendChild(textContainer);

    // Add streaming indicator or completion badge
    if (streamingState && streamingState.isStreaming) {
      const indicator = document.createElement('div');
      indicator.className = 'streaming-indicator';
      // Three dots for animation
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'streaming-dot';
        indicator.appendChild(dot);
      }
      btn.appendChild(indicator);
    } else if (tabsWithCompletions.has(tab.id)) {
      // Add completion badge if tab has unread completion
      const badge = document.createElement('div');
      badge.className = 'completion-badge';
      btn.appendChild(badge);
      btn.classList.add('has-completion');
    }

    // Click handler - switch to tab
    btn.addEventListener('click', () => {
      window.electronAPI.switchService(tab.id);
    });

    // Right-click handler - show native context menu
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const action = await window.electronAPI.showTabContextMenu(tab.id);
      if (action === 'rename') {
        window.electronAPI.showRenameDialog(tab.id);
      } else if (action === 'close') {
        window.electronAPI.closeTab(tab.id);
      }
    });

    // Drag handlers
    btn.addEventListener('dragstart', (e) => {
      draggedTabId = tab.id;
      btn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
    });

    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      draggedTabId = null;
      document.querySelectorAll('.service-btn').forEach(b => {
        b.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });
    });

    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedTabId && draggedTabId !== tab.id) {
        e.dataTransfer.dropEffect = 'move';
        const rect = btn.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        btn.classList.remove('drag-over-top', 'drag-over-bottom');
        if (e.clientY < midY) {
          btn.classList.add('drag-over-top');
        } else {
          btn.classList.add('drag-over-bottom');
        }
      }
    });

    btn.addEventListener('dragleave', () => {
      btn.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drag-over-top', 'drag-over-bottom');

      if (draggedTabId && draggedTabId !== tab.id) {
        const rect = btn.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const position = e.clientY < midY ? 'before' : 'after';
        window.electronAPI.reorderTabs(draggedTabId, tab.id, position);
      }
    });

    container.appendChild(btn);
  });
}

function updateActiveState(tabId) {
  document.querySelectorAll('.service-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabId === tabId);
  });
}


// Keyboard shortcut for reload
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    if (activeTabId) {
      window.electronAPI.reloadService(activeTabId);
    }
  }
});

// ==================== Download Functions ====================

function renderDownloads() {
  renderActiveDownloads();
  renderThumbnails();
  renderFilesList();
}

function renderActiveDownloads() {
  const container = document.getElementById('active-downloads-list');
  const section = document.getElementById('active-downloads-section');

  container.textContent = '';

  if (activeDownloads.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  activeDownloads.forEach(download => {
    const item = document.createElement('div');
    item.className = 'active-download-item';

    const info = document.createElement('div');
    info.className = 'download-info';

    const filename = document.createElement('div');
    filename.className = 'download-filename';
    filename.textContent = truncateFilename(download.filename, 25);
    filename.title = download.filename;
    info.appendChild(filename);

    const progress = document.createElement('div');
    progress.className = 'download-progress';

    const progressBar = document.createElement('div');
    progressBar.className = 'download-progress-bar';
    progressBar.style.width = `${download.percent}%`;
    progress.appendChild(progressBar);
    info.appendChild(progress);

    const stats = document.createElement('div');
    stats.className = 'download-stats';
    stats.textContent = `${download.percent}% • ${formatBytes(download.speed)}/s`;
    info.appendChild(stats);

    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'download-actions';

    if (download.isPaused) {
      const resumeBtn = createActionButton('resume', 'Resume', () => {
        window.electronAPI.resumeDownload(download.id);
      });
      actions.appendChild(resumeBtn);
    } else {
      const pauseBtn = createActionButton('pause', 'Pause', () => {
        window.electronAPI.pauseDownload(download.id);
      });
      actions.appendChild(pauseBtn);
    }

    const cancelBtn = createActionButton('cancel', 'Cancel', () => {
      window.electronAPI.cancelDownload(download.id);
    });
    actions.appendChild(cancelBtn);

    item.appendChild(actions);
    container.appendChild(item);
  });
}

function renderThumbnails() {
  const container = document.getElementById('thumbnails-gallery');
  const section = document.getElementById('thumbnails-section');

  container.textContent = '';

  // Filter completed image downloads with thumbnails
  const images = downloadHistory.filter(d =>
    d.state === 'completed' && d.thumbnailPath
  ).slice(0, 10);

  if (images.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  images.forEach(download => {
    const thumb = document.createElement('div');
    thumb.className = 'thumbnail-item';
    thumb.title = download.filename;

    const img = document.createElement('img');
    img.src = `file://${download.thumbnailPath}`;
    img.alt = download.filename;
    img.addEventListener('error', () => {
      thumb.remove();
    });
    thumb.appendChild(img);

    thumb.addEventListener('click', () => {
      window.electronAPI.openDownload(download.id);
    });

    thumb.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showDownloadContextMenu(download);
    });

    container.appendChild(thumb);
  });
}

function renderFilesList() {
  const container = document.getElementById('files-list');
  const section = document.getElementById('files-section');

  container.textContent = '';

  // Filter completed non-image downloads
  const files = downloadHistory.filter(d =>
    d.state === 'completed' && !d.thumbnailPath
  ).slice(0, 10);

  if (files.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  files.forEach(download => {
    const item = document.createElement('div');
    item.className = 'file-item';

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.innerHTML = getFileIcon(download.filename);
    item.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'file-info';

    const filename = document.createElement('div');
    filename.className = 'file-filename';
    filename.textContent = truncateFilename(download.filename, 20);
    filename.title = download.filename;
    info.appendChild(filename);

    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = formatBytes(download.fileSize || 0);
    info.appendChild(size);

    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const openBtn = createActionButton('open', 'Open', () => {
      window.electronAPI.openDownload(download.id);
    });
    actions.appendChild(openBtn);

    const folderBtn = createActionButton('folder', 'Show in Folder', () => {
      window.electronAPI.showDownloadInFolder(download.id);
    });
    actions.appendChild(folderBtn);

    const removeBtn = createActionButton('remove', 'Remove', () => {
      window.electronAPI.removeDownload(download.id);
    });
    actions.appendChild(removeBtn);

    item.appendChild(actions);
    container.appendChild(item);
  });
}

function createActionButton(type, title, onClick) {
  const btn = document.createElement('button');
  btn.className = `action-btn action-${type}`;
  btn.title = title;

  const icons = {
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    resume: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };

  const template = document.createElement('template');
  template.innerHTML = (icons[type] || '').trim();
  if (template.content.firstChild) {
    btn.appendChild(template.content.cloneNode(true));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });

  return btn;
}

function showDownloadContextMenu(download) {
  // Create a simple context menu
  const existing = document.querySelector('.download-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'download-context-menu';

  const openOption = document.createElement('div');
  openOption.className = 'context-menu-item';
  openOption.textContent = 'Open File';
  openOption.addEventListener('click', () => {
    window.electronAPI.openDownload(download.id);
    menu.remove();
  });
  menu.appendChild(openOption);

  const folderOption = document.createElement('div');
  folderOption.className = 'context-menu-item';
  folderOption.textContent = 'Show in Folder';
  folderOption.addEventListener('click', () => {
    window.electronAPI.showDownloadInFolder(download.id);
    menu.remove();
  });
  menu.appendChild(folderOption);

  const removeOption = document.createElement('div');
  removeOption.className = 'context-menu-item';
  removeOption.textContent = 'Remove from List';
  removeOption.addEventListener('click', () => {
    window.electronAPI.removeDownload(download.id);
    menu.remove();
  });
  menu.appendChild(removeOption);

  document.body.appendChild(menu);

  // Position near the cursor (simplified)
  menu.style.position = 'fixed';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    });
  }, 0);
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    pdf: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM8 14h1v4H8v-4zm3 0h2v4h-2v-4zm4 0h1v4h-1v-4z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/></svg>',
    docx: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/></svg>',
    zip: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2v2z"/></svg>',
    default: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4z"/></svg>'
  };
  return iconMap[ext] || iconMap.default;
}

function truncateFilename(filename, maxLength) {
  if (filename.length <= maxLength) return filename;
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  const nameWithoutExt = filename.slice(0, filename.length - ext.length);
  const truncatedName = nameWithoutExt.slice(0, maxLength - ext.length - 3);
  return truncatedName + '...' + ext;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ==================== History Functions ====================

function renderHistory() {
  const container = document.getElementById('history-list');
  const emptyState = document.getElementById('history-empty');

  container.textContent = '';

  if (historySessions.length === 0) {
    emptyState.style.display = 'block';
    container.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  container.style.display = 'block';

  // Group sessions by date
  const groupedSessions = groupSessionsByDate(historySessions);

  for (const [dateLabel, sessions] of Object.entries(groupedSessions)) {
    const dateGroup = document.createElement('div');
    dateGroup.className = 'history-date-group';

    const dateHeader = document.createElement('div');
    dateHeader.className = 'history-date-header';
    dateHeader.textContent = dateLabel;
    dateGroup.appendChild(dateHeader);

    sessions.forEach(session => {
      const item = createHistoryItem(session);
      dateGroup.appendChild(item);
    });

    container.appendChild(dateGroup);
  }
}

function groupSessionsByDate(sessions) {
  const groups = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  sessions.forEach(session => {
    const sessionDate = new Date(session.timestamp);
    const sessionDay = new Date(sessionDate.getFullYear(), sessionDate.getMonth(), sessionDate.getDate());

    let label;
    if (sessionDay.getTime() === today.getTime()) {
      label = 'Today';
    } else if (sessionDay.getTime() === yesterday.getTime()) {
      label = 'Yesterday';
    } else {
      label = sessionDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }

    if (!groups[label]) {
      groups[label] = [];
    }
    groups[label].push(session);
  });

  return groups;
}

function createHistoryItem(session) {
  const item = document.createElement('div');
  item.className = 'history-item';
  item.dataset.sessionId = session.id;

  const icon = document.createElement('div');
  icon.className = 'history-icon';
  // Use template for safe SVG insertion
  const iconTemplate = document.createElement('template');
  iconTemplate.innerHTML = (SERVICE_ICONS['claude-code'] || '').trim();
  if (iconTemplate.content.firstChild) {
    icon.appendChild(iconTemplate.content.cloneNode(true));
  }
  item.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'history-info';

  const name = document.createElement('div');
  name.className = 'history-name';
  name.textContent = session.cwdName || 'Session';
  name.title = session.cwd;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const time = new Date(session.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const duration = formatDuration(session.duration);
  meta.textContent = `${time} • ${duration}`;
  info.appendChild(meta);

  item.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'history-actions';

  const viewBtn = createHistoryActionButton('view', 'View', () => {
    viewHistorySession(session.id);
  });
  actions.appendChild(viewBtn);

  const exportBtn = createHistoryActionButton('export', 'Export', async () => {
    await window.electronAPI.exportHistorySession(session.id);
  });
  actions.appendChild(exportBtn);

  const deleteBtn = createHistoryActionButton('delete', 'Delete', async () => {
    if (confirm('Delete this session from history?')) {
      await window.electronAPI.deleteHistorySession(session.id);
    }
  });
  actions.appendChild(deleteBtn);

  item.appendChild(actions);

  // Click on item to view
  item.addEventListener('click', (e) => {
    if (!e.target.closest('.history-actions')) {
      viewHistorySession(session.id);
    }
  });

  return item;
}

const HISTORY_ACTION_ICONS = {
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
};

function createHistoryActionButton(type, title, onClick) {
  const btn = document.createElement('button');
  btn.className = `history-action-btn action-${type}`;
  btn.title = title;

  // Use template for safe SVG insertion
  const template = document.createElement('template');
  template.innerHTML = (HISTORY_ACTION_ICONS[type] || '').trim();
  if (template.content.firstChild) {
    btn.appendChild(template.content.cloneNode(true));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });

  return btn;
}

async function viewHistorySession(sessionId) {
  const content = await window.electronAPI.readHistorySession(sessionId);
  if (content) {
    showHistoryModal(sessionId, content);
  }
}

function showHistoryModal(sessionId, content) {
  // Create a simple modal to show the session content
  const existing = document.querySelector('.history-viewer-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'history-viewer-modal';

  const header = document.createElement('div');
  header.className = 'history-viewer-header';

  const title = document.createElement('span');
  title.textContent = 'Session History';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'history-viewer-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => modal.remove());
  header.appendChild(closeBtn);

  modal.appendChild(header);

  const contentArea = document.createElement('div');
  contentArea.className = 'history-viewer-content';
  // Strip ANSI codes for display
  const cleanContent = content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  contentArea.textContent = cleanContent;
  modal.appendChild(contentArea);

  document.body.appendChild(modal);

  // Close on escape
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '--';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

init();
