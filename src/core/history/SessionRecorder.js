/**
 * SessionRecorder - In-memory buffer for capturing PTY output
 *
 * Handles:
 * - Buffering PTY output chunks in memory
 * - Compressing buffer to gzip on finalization
 * - Tracking uncompressed/compressed sizes
 * - Graceful abort handling
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

// Maximum buffer size before we start dropping old data (100MB)
const MAX_BUFFER_SIZE = 100 * 1024 * 1024;

class SessionRecorder {
  /**
   * @param {string} sessionId - Unique session identifier
   * @param {string} cwd - Working directory for this session
   */
  constructor(sessionId, cwd) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.chunks = [];
    this.totalSize = 0;
    this.startTime = Date.now();
    this.isAborted = false;
    this.isFinalized = false;
  }

  /**
   * Write data to the buffer
   * @param {string|Buffer} data - PTY output data
   */
  write(data) {
    if (this.isAborted || this.isFinalized) {
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.chunks.push(chunk);
    this.totalSize += chunk.length;

    // If we exceed max buffer, drop oldest chunks
    if (this.totalSize > MAX_BUFFER_SIZE) {
      this._trimBuffer();
    }
  }

  /**
   * Trim buffer to stay under MAX_BUFFER_SIZE
   * @private
   */
  _trimBuffer() {
    let removedSize = 0;
    const targetSize = MAX_BUFFER_SIZE * 0.8; // Trim to 80%

    while (this.chunks.length > 0 && this.totalSize - removedSize > targetSize) {
      const chunk = this.chunks.shift();
      removedSize += chunk.length;
    }

    this.totalSize -= removedSize;

    // Prepend a marker indicating data was truncated
    const marker = Buffer.from('\n[...earlier output truncated...]\n');
    this.chunks.unshift(marker);
    this.totalSize += marker.length;
  }

  /**
   * Get current buffer size (uncompressed)
   * @returns {number} Size in bytes
   */
  getBufferSize() {
    return this.totalSize;
  }

  /**
   * Get session duration so far
   * @returns {number} Duration in milliseconds
   */
  getDuration() {
    return Date.now() - this.startTime;
  }

  /**
   * Finalize the session and compress the buffer
   * @param {number} exitCode - Process exit code
   * @returns {Promise<{compressed: Buffer, uncompressedSize: number, compressedSize: number, duration: number}>}
   */
  async finalize(exitCode) {
    if (this.isAborted) {
      throw new Error('Cannot finalize an aborted session');
    }

    if (this.isFinalized) {
      throw new Error('Session already finalized');
    }

    this.isFinalized = true;

    // Combine all chunks
    const fullBuffer = Buffer.concat(this.chunks);
    const uncompressedSize = fullBuffer.length;

    // Compress with gzip
    const compressed = await gzip(fullBuffer, { level: 6 });
    const compressedSize = compressed.length;

    // Clear chunks to free memory
    this.chunks = [];
    this.totalSize = 0;

    return {
      compressed,
      uncompressedSize,
      compressedSize,
      duration: this.getDuration(),
      exitCode
    };
  }

  /**
   * Abort the recording without saving
   */
  abort() {
    this.isAborted = true;
    this.chunks = [];
    this.totalSize = 0;
  }

  /**
   * Check if recording is still active
   * @returns {boolean}
   */
  isActive() {
    return !this.isAborted && !this.isFinalized;
  }

  /**
   * Get session metadata
   * @returns {Object}
   */
  getMetadata() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      startTime: this.startTime,
      bufferSize: this.totalSize,
      isActive: this.isActive()
    };
  }
}

module.exports = SessionRecorder;
