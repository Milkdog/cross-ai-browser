console.log('service-picker.js loaded');

// Service definitions (mirrored from ServiceRegistry for renderer)
const SERVICE_TYPES = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    type: 'web',
    color: '#10a37f',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.6 8.3829l2.02-1.1638a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
    </svg>`
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    type: 'web',
    color: '#d97757',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.603 15.401l2.76-6.952h.104l2.776 6.952h-1.14l-.637-1.669H6.364l-.62 1.669h-1.14zm2.4-2.622h1.664l-.817-2.2h-.031l-.816 2.2z"/>
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17z"/>
    </svg>`
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    type: 'web',
    color: '#8ab4f8',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L9.19 9.19 2 12l7.19 2.81L12 22l2.81-7.19L22 12l-7.19-2.81L12 2z"/>
    </svg>`
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    type: 'terminal',
    color: '#22c55e',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>`
  }
};

function init() {
  const grid = document.getElementById('service-grid');
  const closeBtn = document.getElementById('close-btn');
  const backdrop = document.getElementById('backdrop');

  // Parse query params for configuration
  const params = new URLSearchParams(window.location.search);
  const isFirstTime = params.get('firstTime') === 'true';
  const terminalAvailable = params.get('terminalAvailable') !== 'false';

  // Update title/description for first-time experience
  if (isFirstTime) {
    document.getElementById('modal-title').textContent = 'Welcome to Cross AI Browser';
    document.getElementById('modal-description').textContent = 'Select a service to get started';
    closeBtn.style.display = 'none';
  }

  // Filter services based on availability
  const availableServices = Object.values(SERVICE_TYPES).filter(service => {
    if (service.type === 'terminal' && !terminalAvailable) {
      return false;
    }
    return true;
  });

  // Render service cards using safe DOM methods
  availableServices.forEach(service => {
    const card = document.createElement('button');
    card.className = 'service-card';
    card.dataset.service = service.id;
    card.tabIndex = 0;

    // Create icon container using template for safe SVG insertion
    const iconDiv = document.createElement('div');
    iconDiv.className = 'service-icon';
    const template = document.createElement('template');
    template.innerHTML = service.icon.trim();
    iconDiv.appendChild(template.content.cloneNode(true));

    // Create name element with textContent (safe)
    const nameDiv = document.createElement('div');
    nameDiv.className = 'service-name';
    nameDiv.textContent = service.name;

    // Create type label with textContent (safe)
    const typeDiv = document.createElement('div');
    typeDiv.className = 'service-type';
    typeDiv.textContent = service.type === 'terminal' ? 'Terminal' : 'Web App';

    // Assemble card
    card.appendChild(iconDiv);
    card.appendChild(nameDiv);
    card.appendChild(typeDiv);

    card.addEventListener('click', () => {
      selectService(service.id);
    });

    // Keyboard support
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectService(service.id);
      }
    });

    grid.appendChild(card);
  });

  // Close button
  closeBtn.addEventListener('click', () => {
    window.electronAPI.closeServicePicker();
  });

  // Click outside to close (unless first time)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && !isFirstTime) {
      window.electronAPI.closeServicePicker();
    }
  });

  // Escape to close (unless first time)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !isFirstTime) {
      window.electronAPI.closeServicePicker();
    }
  });

  // Focus first card
  const firstCard = grid.querySelector('.service-card');
  if (firstCard) {
    firstCard.focus();
  }
}

function selectService(serviceId) {
  const service = SERVICE_TYPES[serviceId];
  if (!service) return;

  if (service.type === 'terminal') {
    // For terminal, we need to select a folder first
    window.electronAPI.selectFolderAndCreateTab(serviceId);
  } else {
    // For web services, just create the tab
    window.electronAPI.createTab(serviceId);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
