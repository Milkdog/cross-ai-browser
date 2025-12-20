/**
 * DownloadManager - Centralized download tracking and persistence
 *
 * Manages downloads from shared session, tracks progress,
 * persists history, and handles save mode settings.
 */
const { app, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

class DownloadManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - electron-store instance
   * @param {Object} options.session - Electron session to monitor
   * @param {Object} options.getMainWindow - Function to get main window for dialogs
   */
  constructor({ store, session, getMainWindow }) {
    super();
    this.store = store;
    this.session = session;
    this.getMainWindow = getMainWindow || (() => null);

    // Active downloads: Map<downloadId, { item, meta }>
    this.activeDownloads = new Map();

    // Progress tracking for speed calculation
    this.progressTracking = new Map();

    // Ensure store structure exists
    this._initializeStore();
  }

  /**
   * Initialize store with default structure if needed
   * @private
   */
  _initializeStore() {
    if (!this.store.has('downloads')) {
      this.store.set('downloads', {
        items: [],
        settings: { saveMode: 'ask' }
      });
    }
    if (!this.store.has('ui.sidebarExpanded')) {
      this.store.set('ui.sidebarExpanded', false);
    }
  }

  /**
   * Start monitoring session for downloads
   */
  initialize() {
    this.session.on('will-download', (event, item, webContents) => {
      this._handleDownload(item, webContents);
    });
  }

  /**
   * Handle a new download
   * @private
   */
  _handleDownload(item, webContents) {
    const downloadId = crypto.randomUUID();
    const saveMode = this.getSaveMode();
    const filename = item.getFilename();


    // Determine source service from webContents URL
    const sourceService = this._getSourceService(webContents);

    // Create metadata object (savePath will be set after dialog if needed)
    const meta = {
      id: downloadId,
      filename: filename,
      savePath: null,
      totalBytes: item.getTotalBytes(),
      state: 'downloading',
      sourceService,
      startTime: Date.now(),
      url: item.getURL()
    };

    // Track download immediately
    this.activeDownloads.set(downloadId, { item, meta });
    this.progressTracking.set(downloadId, {
      lastUpdate: Date.now(),
      lastReceived: 0,
      speed: 0
    });

    // Set up event handlers IMMEDIATELY (before any async operations)
    // This ensures we catch the done event even for fast blob downloads
    item.on('updated', (event, state) => {
      if (state === 'progressing') {
        this._updateProgress(downloadId, item);
      } else if (state === 'interrupted') {
        meta.state = 'paused';
        this._emitUpdate();
      }
    });

    item.once('done', (event, state) => {
      this.activeDownloads.delete(downloadId);
      this.progressTracking.delete(downloadId);

      if (state === 'completed') {
        const completedItem = {
          ...meta,
          savePath: item.getSavePath(), // Get final save path
          state: 'completed',
          fileSize: item.getTotalBytes(),
          completedTime: Date.now()
        };

        this._addToHistory(completedItem);

        // Generate thumbnail for images
        if (this._isImage(filename)) {
          this._generateThumbnail(downloadId, item.getSavePath());
        }

        this.emit('download-completed', completedItem);
      } else if (state === 'cancelled') {
        this._addToHistory({ ...meta, state: 'cancelled', completedTime: Date.now() });
      } else {
        this._addToHistory({ ...meta, state: 'failed', completedTime: Date.now() });
      }

      this._emitUpdate();
    });

    // Now handle save location based on mode
    // IMPORTANT: Use synchronous dialog to prevent download events from firing during user input
    if (saveMode === 'ask') {
      const mainWindow = this.getMainWindow();
      const dialogOptions = {
        defaultPath: path.join(app.getPath('downloads'), filename),
        title: 'Save Download'
      };

      // Use synchronous dialog to block event loop while user selects location
      const filePath = mainWindow
        ? dialog.showSaveDialogSync(mainWindow, dialogOptions)
        : dialog.showSaveDialogSync(dialogOptions);


      if (!filePath) {
        // User cancelled
        item.cancel();
        this.activeDownloads.delete(downloadId);
        this.progressTracking.delete(downloadId);
        return;
      }
      item.setSavePath(filePath);
      meta.savePath = filePath;
    } else {
      // Auto-save to Downloads folder
      const savePath = this._getUniquePath(app.getPath('downloads'), filename);
      item.setSavePath(savePath);
      meta.savePath = savePath;
    }

    // Emit initial update
    this._emitUpdate();

  }

  /**
   * Get unique file path (add number suffix if exists)
   * @private
   */
  _getUniquePath(dir, filename) {
    let savePath = path.join(dir, filename);
    let counter = 1;
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    while (fs.existsSync(savePath)) {
      savePath = path.join(dir, `${base} (${counter})${ext}`);
      counter++;
    }

    return savePath;
  }

  /**
   * Determine source service from webContents URL
   * @private
   */
  _getSourceService(webContents) {
    try {
      const url = webContents.getURL();
      if (url.includes('chat.openai.com') || url.includes('chatgpt.com')) return 'chatgpt';
      if (url.includes('claude.ai')) return 'claude';
      if (url.includes('gemini.google.com')) return 'gemini';
    } catch (e) {
      // webContents may be destroyed
    }
    return 'unknown';
  }

  /**
   * Check if file is an image
   * @private
   */
  _isImage(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
  }

  /**
   * Update download progress and calculate speed
   * @private
   */
  _updateProgress(downloadId, item) {
    const tracking = this.progressTracking.get(downloadId);
    if (!tracking) return;

    const now = Date.now();
    const received = item.getReceivedBytes();
    const timeDelta = (now - tracking.lastUpdate) / 1000;

    // Calculate speed (update every 500ms minimum)
    let speed = tracking.speed;
    if (timeDelta >= 0.5) {
      const bytesDelta = received - tracking.lastReceived;
      speed = Math.round(bytesDelta / timeDelta);

      tracking.lastUpdate = now;
      tracking.lastReceived = received;
      tracking.speed = speed;
    }

    this._emitUpdate();
  }

  /**
   * Generate thumbnail for image downloads
   * @private
   */
  _generateThumbnail(downloadId, imagePath) {
    try {
      const image = nativeImage.createFromPath(imagePath);
      if (image.isEmpty()) return;

      const thumbnail = image.resize({ width: 120, height: 120, quality: 'good' });

      // Save thumbnail to app data
      const thumbnailDir = path.join(app.getPath('userData'), 'thumbnails');
      if (!fs.existsSync(thumbnailDir)) {
        fs.mkdirSync(thumbnailDir, { recursive: true });
      }

      const thumbnailPath = path.join(thumbnailDir, `${downloadId}.png`);
      fs.writeFileSync(thumbnailPath, thumbnail.toPNG());

      // Update history item with thumbnail path
      const downloads = this.store.get('downloads');
      const item = downloads.items.find(d => d.id === downloadId);
      if (item) {
        item.thumbnailPath = thumbnailPath;
        this.store.set('downloads', downloads);
        this._emitUpdate();
      }
    } catch (err) {
      console.error('Failed to generate thumbnail:', err);
    }
  }

  /**
   * Add item to download history
   * @private
   */
  _addToHistory(item) {
    const downloads = this.store.get('downloads');
    downloads.items.unshift(item);

    // Keep last 100 items
    if (downloads.items.length > 100) {
      const removed = downloads.items.splice(100);
      // Clean up old thumbnails
      removed.forEach(d => {
        if (d.thumbnailPath && fs.existsSync(d.thumbnailPath)) {
          try { fs.unlinkSync(d.thumbnailPath); } catch (e) {}
        }
      });
    }

    this.store.set('downloads', downloads);
  }

  /**
   * Emit update event with current state
   * @private
   */
  _emitUpdate() {
    this.emit('downloads-updated', {
      active: this.getActiveDownloads(),
      history: this.getDownloadHistory(20)
    });
  }

  // ============== Public API ==============

  /**
   * Get all active downloads with progress info
   */
  getActiveDownloads() {
    return Array.from(this.activeDownloads.entries()).map(([id, { item, meta }]) => {
      const tracking = this.progressTracking.get(id) || {};
      const total = item.getTotalBytes();
      const received = item.getReceivedBytes();
      const percent = total > 0 ? Math.round((received / total) * 100) : 0;

      return {
        id,
        filename: meta.filename,
        state: item.isPaused() ? 'paused' : 'downloading',
        totalBytes: total,
        receivedBytes: received,
        percent,
        speed: tracking.speed || 0,
        canResume: item.canResume(),
        isPaused: item.isPaused()
      };
    });
  }

  /**
   * Get download history from store
   */
  getDownloadHistory(limit = 50) {
    const downloads = this.store.get('downloads');
    return (downloads.items || []).slice(0, limit);
  }

  /**
   * Get a specific download by ID
   */
  getDownloadById(id) {
    // Check active first
    const active = this.activeDownloads.get(id);
    if (active) return active.meta;

    // Check history
    const downloads = this.store.get('downloads');
    return downloads.items.find(d => d.id === id);
  }

  /**
   * Pause an active download
   */
  pauseDownload(id) {
    const download = this.activeDownloads.get(id);
    if (download && !download.item.isPaused()) {
      download.item.pause();
      this._emitUpdate();
      return true;
    }
    return false;
  }

  /**
   * Resume a paused download
   */
  resumeDownload(id) {
    const download = this.activeDownloads.get(id);
    if (download && download.item.canResume()) {
      download.item.resume();
      this._emitUpdate();
      return true;
    }
    return false;
  }

  /**
   * Cancel an active download
   */
  cancelDownload(id) {
    const download = this.activeDownloads.get(id);
    if (download) {
      download.item.cancel();
      return true;
    }
    return false;
  }

  /**
   * Remove a download from history
   */
  removeFromHistory(id) {
    const downloads = this.store.get('downloads');
    const index = downloads.items.findIndex(d => d.id === id);

    if (index !== -1) {
      const item = downloads.items[index];

      // Delete thumbnail if exists
      if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
        try { fs.unlinkSync(item.thumbnailPath); } catch (e) {}
      }

      downloads.items.splice(index, 1);
      this.store.set('downloads', downloads);
      this._emitUpdate();
      return true;
    }
    return false;
  }

  /**
   * Clear all download history
   */
  clearHistory() {
    // Clear thumbnails directory
    const thumbnailDir = path.join(app.getPath('userData'), 'thumbnails');
    if (fs.existsSync(thumbnailDir)) {
      try {
        fs.rmSync(thumbnailDir, { recursive: true, force: true });
        fs.mkdirSync(thumbnailDir, { recursive: true });
      } catch (err) {
        console.error('Failed to clear thumbnails:', err);
      }
    }

    const downloads = this.store.get('downloads');
    downloads.items = [];
    this.store.set('downloads', downloads);
    this._emitUpdate();
  }

  /**
   * Open a downloaded file
   */
  openDownload(id) {
    const download = this.getDownloadById(id);
    if (download && download.savePath && fs.existsSync(download.savePath)) {
      shell.openPath(download.savePath);
      return true;
    }
    return false;
  }

  /**
   * Show download in folder
   */
  showInFolder(id) {
    const download = this.getDownloadById(id);
    if (download && download.savePath && fs.existsSync(download.savePath)) {
      shell.showItemInFolder(download.savePath);
      return true;
    }
    return false;
  }

  /**
   * Get current save mode setting
   */
  getSaveMode() {
    const downloads = this.store.get('downloads');
    return downloads.settings?.saveMode || 'ask';
  }

  /**
   * Set save mode setting
   */
  setSaveMode(mode) {
    if (!['ask', 'auto'].includes(mode)) {
      throw new Error('Invalid save mode');
    }

    const downloads = this.store.get('downloads');
    if (!downloads.settings) {
      downloads.settings = { saveMode: 'ask' };
    }
    downloads.settings.saveMode = mode;
    this.store.set('downloads', downloads);
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.activeDownloads.clear();
    this.progressTracking.clear();
    this.removeAllListeners();
  }
}

module.exports = DownloadManager;
