/**
 * PromptImageManager - Handles image attachments for prompts
 *
 * Features:
 * - Store images in app data directory
 * - Generate thumbnails using nativeImage
 * - Support file picker, drag & drop, clipboard paste
 * - Clean up images when prompts are deleted
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');

class PromptImageManager {
  /**
   * @param {string} userDataPath - Electron app.getPath('userData')
   */
  constructor(userDataPath) {
    this.baseDir = path.join(userDataPath, 'prompt-images');
    this.thumbnailSize = 120;
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
    this.allowedFormats = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    this._ensureBaseDir();
  }

  /**
   * Ensure the images directory exists
   * @private
   */
  _ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Generate a unique image ID
   * @returns {string}
   */
  _generateImageId() {
    return `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Get the file path for an image
   * @param {string} imageId
   * @param {string} ext - File extension including dot
   * @returns {string}
   */
  _getImagePath(imageId, ext) {
    return path.join(this.baseDir, `${imageId}${ext}`);
  }

  /**
   * Get the thumbnail path for an image
   * @param {string} imageId
   * @returns {string}
   */
  _getThumbnailPath(imageId) {
    return path.join(this.baseDir, `${imageId}_thumb.png`);
  }

  /**
   * Validate image file
   * @param {string} filePath
   * @returns {{valid: boolean, error?: string}}
   */
  validateImage(filePath) {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'File does not exist' };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!this.allowedFormats.includes(ext)) {
      return { valid: false, error: `Invalid format. Allowed: ${this.allowedFormats.join(', ')}` };
    }

    const stats = fs.statSync(filePath);
    if (stats.size > this.maxFileSize) {
      return { valid: false, error: `File too large. Maximum: ${this.maxFileSize / 1024 / 1024}MB` };
    }

    return { valid: true };
  }

  /**
   * Generate a thumbnail for an image
   * @param {string} sourcePath - Path to original image
   * @param {string} thumbnailPath - Path to save thumbnail
   * @returns {Promise<boolean>}
   */
  async generateThumbnail(sourcePath, thumbnailPath) {
    try {
      const image = nativeImage.createFromPath(sourcePath);
      if (image.isEmpty()) {
        console.error('Failed to load image for thumbnail:', sourcePath);
        return false;
      }

      const size = image.getSize();
      console.log('generateThumbnail: source size:', size.width, 'x', size.height);
      const maxDim = Math.max(size.width, size.height);

      let pngBuffer;
      if (maxDim <= this.thumbnailSize) {
        // Image is already small enough, just copy it
        pngBuffer = image.toPNG();
      } else {
        // Calculate new dimensions maintaining aspect ratio
        const scale = this.thumbnailSize / maxDim;
        const newWidth = Math.round(size.width * scale);
        const newHeight = Math.round(size.height * scale);
        console.log('generateThumbnail: resizing to:', newWidth, 'x', newHeight);

        const resized = image.resize({ width: newWidth, height: newHeight, quality: 'good' });
        pngBuffer = resized.toPNG();
      }

      // Validate PNG buffer has content and valid header
      if (!pngBuffer || pngBuffer.length < 8) {
        console.error('generateThumbnail: PNG buffer is empty or too small');
        return false;
      }

      // Check PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngMagic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
      const hasValidHeader = pngMagic.every((byte, i) => pngBuffer[i] === byte);
      if (!hasValidHeader) {
        console.error('generateThumbnail: PNG buffer has invalid header');
        return false;
      }

      console.log('generateThumbnail: saving PNG buffer, size:', pngBuffer.length);
      await fs.promises.writeFile(thumbnailPath, pngBuffer);

      // Verify the file was written correctly
      const writtenSize = (await fs.promises.stat(thumbnailPath)).size;
      console.log('generateThumbnail: written file size:', writtenSize);

      return true;
    } catch (err) {
      console.error('Failed to generate thumbnail:', err);
      return false;
    }
  }

  /**
   * Add an image from a file path
   * @param {string} sourcePath - Path to the image file
   * @returns {Promise<{success: boolean, image?: object, error?: string}>}
   */
  async addImage(sourcePath) {
    const validation = this.validateImage(sourcePath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const imageId = this._generateImageId();
    const ext = path.extname(sourcePath).toLowerCase();
    const destPath = this._getImagePath(imageId, ext);
    const thumbnailPath = this._getThumbnailPath(imageId);

    try {
      // Copy original image
      await fs.promises.copyFile(sourcePath, destPath);

      // Generate thumbnail (non-fatal if it fails)
      const thumbnailSuccess = await this.generateThumbnail(destPath, thumbnailPath);
      if (!thumbnailSuccess) {
        console.warn('Thumbnail generation failed, will use original image for preview');
      }

      const stats = fs.statSync(destPath);
      const nImage = nativeImage.createFromPath(destPath);
      const size = nImage.getSize();

      const imageData = {
        id: imageId,
        filename: path.basename(sourcePath),
        path: destPath,
        thumbnailPath: thumbnailPath,
        size: stats.size,
        width: size.width,
        height: size.height,
        addedAt: Date.now()
      };

      return { success: true, image: imageData };
    } catch (err) {
      // Clean up on failure
      try {
        if (fs.existsSync(destPath)) await fs.promises.unlink(destPath);
        if (fs.existsSync(thumbnailPath)) await fs.promises.unlink(thumbnailPath);
      } catch {
        // Ignore cleanup errors
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Add an image from clipboard data (base64 or buffer)
   * @param {string} dataUrl - Data URL (e.g., data:image/png;base64,...)
   * @returns {Promise<{success: boolean, image?: object, error?: string}>}
   */
  async addImageFromDataUrl(dataUrl) {
    try {
      console.log('addImageFromDataUrl: dataUrl length:', dataUrl?.length);
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) {
        console.error('addImageFromDataUrl: nativeImage is empty');
        return { success: false, error: 'Invalid image data' };
      }

      const size = image.getSize();
      console.log('addImageFromDataUrl: image size:', size.width, 'x', size.height);

      const imageId = this._generateImageId();
      const destPath = this._getImagePath(imageId, '.png');
      const thumbnailPath = this._getThumbnailPath(imageId);

      // Save as PNG
      const pngBuffer = image.toPNG();
      console.log('addImageFromDataUrl: PNG buffer size:', pngBuffer.length);

      // Validate PNG buffer
      if (!pngBuffer || pngBuffer.length < 8) {
        console.error('addImageFromDataUrl: PNG buffer is empty or too small');
        return { success: false, error: 'Failed to convert image to PNG' };
      }

      // Check PNG magic bytes
      const pngMagic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
      const hasValidHeader = pngMagic.every((byte, i) => pngBuffer[i] === byte);
      if (!hasValidHeader) {
        console.error('addImageFromDataUrl: PNG buffer has invalid header');
        return { success: false, error: 'Failed to create valid PNG' };
      }

      if (pngBuffer.length > this.maxFileSize) {
        return { success: false, error: `Image too large. Maximum: ${this.maxFileSize / 1024 / 1024}MB` };
      }

      await fs.promises.writeFile(destPath, pngBuffer);
      console.log('addImageFromDataUrl: saved to:', destPath);

      // Generate thumbnail
      const thumbnailSuccess = await this.generateThumbnail(destPath, thumbnailPath);
      console.log('addImageFromDataUrl: thumbnail success:', thumbnailSuccess);

      const imageData = {
        id: imageId,
        filename: `clipboard-${Date.now()}.png`,
        path: destPath,
        thumbnailPath: thumbnailPath,
        size: pngBuffer.length,
        width: size.width,
        height: size.height,
        addedAt: Date.now()
      };

      return { success: true, image: imageData };
    } catch (err) {
      console.error('addImageFromDataUrl error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Remove an image and its thumbnail
   * @param {string} imageId
   * @returns {Promise<boolean>}
   */
  async removeImage(imageId) {
    try {
      // Find the image file (could have different extensions)
      const files = await fs.promises.readdir(this.baseDir);
      const imageFile = files.find(f => f.startsWith(imageId) && !f.includes('_thumb'));

      if (imageFile) {
        await fs.promises.unlink(path.join(this.baseDir, imageFile));
      }

      const thumbnailPath = this._getThumbnailPath(imageId);
      if (fs.existsSync(thumbnailPath)) {
        await fs.promises.unlink(thumbnailPath);
      }

      return true;
    } catch (err) {
      console.error('Failed to remove image:', err);
      return false;
    }
  }

  /**
   * Remove multiple images (used when deleting a prompt)
   * @param {Array<{id: string}>} images - Array of image objects
   * @returns {Promise<void>}
   */
  async removeImages(images) {
    if (!Array.isArray(images)) return;

    for (const img of images) {
      if (img && img.id) {
        await this.removeImage(img.id);
      }
    }
  }

  /**
   * Get thumbnail as data URL for display
   * Falls back to original image (resized) if thumbnail doesn't exist
   * @param {string} imageId
   * @returns {string|null} Data URL or null if not found
   */
  getThumbnailDataUrl(imageId) {
    console.log('getThumbnailDataUrl called for:', imageId);
    const thumbnailPath = this._getThumbnailPath(imageId);
    console.log('  thumbnailPath:', thumbnailPath, 'exists:', fs.existsSync(thumbnailPath));

    // Try thumbnail first - read file directly and encode to base64
    if (fs.existsSync(thumbnailPath)) {
      try {
        const buffer = fs.readFileSync(thumbnailPath);
        const base64 = buffer.toString('base64');
        console.log('  thumbnail loaded, size:', buffer.length, 'base64 length:', base64.length);
        return `data:image/png;base64,${base64}`;
      } catch (err) {
        console.error('Failed to load thumbnail:', err);
      }
    }

    // Fall back to original image
    const originalPath = this.getImagePath(imageId);
    console.log('  originalPath:', originalPath);
    if (!originalPath) {
      console.log('  No original path found');
      return null;
    }

    try {
      // Get the file extension to determine mime type
      const ext = path.extname(originalPath).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
      };
      const mimeType = mimeTypes[ext] || 'image/png';

      // For original images, we need to resize them for thumbnail
      const image = nativeImage.createFromPath(originalPath);
      console.log('  original image isEmpty:', image.isEmpty());
      if (image.isEmpty()) return null;

      const size = image.getSize();
      const maxDim = Math.max(size.width, size.height);

      let pngBuffer;
      if (maxDim > this.thumbnailSize) {
        const scale = this.thumbnailSize / maxDim;
        const newWidth = Math.round(size.width * scale);
        const newHeight = Math.round(size.height * scale);
        const resized = image.resize({ width: newWidth, height: newHeight, quality: 'good' });
        pngBuffer = resized.toPNG();
      } else {
        pngBuffer = image.toPNG();
      }

      const base64 = pngBuffer.toString('base64');
      console.log('  original resized, buffer size:', pngBuffer.length, 'base64 length:', base64.length);
      return `data:image/png;base64,${base64}`;
    } catch (err) {
      console.error('Failed to get image data URL:', err);
      return null;
    }
  }

  /**
   * Get the original image path for sending to terminal
   * @param {string} imageId
   * @returns {string|null}
   */
  getImagePath(imageId) {
    try {
      const files = fs.readdirSync(this.baseDir);
      const imageFile = files.find(f => f.startsWith(imageId) && !f.includes('_thumb'));

      if (imageFile) {
        return path.join(this.baseDir, imageFile);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if an image exists
   * @param {string} imageId
   * @returns {boolean}
   */
  imageExists(imageId) {
    return this.getImagePath(imageId) !== null;
  }

  /**
   * Get storage directory path
   * @returns {string}
   */
  getBaseDir() {
    return this.baseDir;
  }

  /**
   * Copy an image to temp directory for terminal access
   * This is needed because Claude Code may not have permission to read from app data
   * @param {string} imageId
   * @returns {Promise<string|null>} Temp file path or null if failed
   */
  async copyToTemp(imageId) {
    const originalPath = this.getImagePath(imageId);
    if (!originalPath) {
      return null;
    }

    try {
      const os = require('os');
      const tempDir = os.tmpdir();
      const ext = path.extname(originalPath);
      const timestamp = Date.now();
      const tempPath = path.join(tempDir, `claude-prompt-img-${timestamp}${ext}`);

      await fs.promises.copyFile(originalPath, tempPath);
      return tempPath;
    } catch (err) {
      console.error('Failed to copy image to temp:', err);
      return null;
    }
  }

  /**
   * Copy an image to the system clipboard
   * This allows Claude Code to detect it when paste is triggered
   * @param {string} imageId
   * @returns {Promise<boolean>} Success status
   */
  async copyToClipboard(imageId) {
    const originalPath = this.getImagePath(imageId);
    if (!originalPath) {
      console.error('copyToClipboard: Image not found:', imageId);
      return false;
    }

    try {
      const { clipboard } = require('electron');
      const image = nativeImage.createFromPath(originalPath);

      if (image.isEmpty()) {
        console.error('copyToClipboard: Failed to load image:', originalPath);
        return false;
      }

      clipboard.writeImage(image);
      console.log('copyToClipboard: Image copied to clipboard:', imageId);
      return true;
    } catch (err) {
      console.error('Failed to copy image to clipboard:', err);
      return false;
    }
  }
}

module.exports = PromptImageManager;
