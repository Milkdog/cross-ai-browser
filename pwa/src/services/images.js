/**
 * Images Service
 * Handles image upload and retrieval from Firebase Storage
 */

import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from 'firebase/storage';
import { storage, isConfigured } from './firebase';

/**
 * Upload an image to Firebase Storage
 * @param {string} userId
 * @param {File|Blob} file - Image file
 * @param {string} imageId - Unique ID for the image
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function uploadImage(userId, file, imageId) {
  if (!isConfigured || !storage) {
    return { success: false, error: 'Firebase Storage not configured' };
  }

  try {
    const storageRef = ref(storage, `users/${userId}/images/${imageId}`);
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    return { success: true, url };
  } catch (error) {
    console.error('Error uploading image:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get download URL for an image
 * @param {string} userId
 * @param {string} imageId
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function getImageUrl(userId, imageId) {
  if (!isConfigured || !storage) {
    return { success: false, error: 'Firebase Storage not configured' };
  }

  try {
    const storageRef = ref(storage, `users/${userId}/images/${imageId}`);
    const url = await getDownloadURL(storageRef);
    return { success: true, url };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Get download URL for an image's 120px thumbnail.
 */
export async function getThumbnailUrl(userId, imageId) {
  if (!isConfigured || !storage) {
    return { success: false, error: 'Firebase Storage not configured' };
  }
  try {
    const storageRef = ref(storage, `users/${userId}/images/${imageId}_thumb`);
    const url = await getDownloadURL(storageRef);
    return { success: true, url };
  } catch (error) {
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Generate a 120px PNG thumbnail from a File/Blob using a canvas.
 */
export async function generateThumbnailBlob(file, maxDim = 120) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const { width: w, height: h } = img;
  const maxSide = Math.max(w, h);
  const scale = maxSide > maxDim ? maxDim / maxSide : 1;
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tw, th);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return { blob, width: w, height: h };
}

/**
 * Upload an image (original + 120px thumbnail) to Firebase Storage.
 * Returns metadata ready to be merged into prompt.images[].
 */
export async function uploadImageWithThumbnail(userId, file, imageId) {
  if (!isConfigured || !storage) {
    return { success: false, error: 'Firebase Storage not configured' };
  }
  try {
    const origRef = ref(storage, `users/${userId}/images/${imageId}`);
    await uploadBytes(origRef, file, { contentType: file.type || 'image/png' });

    let width, height;
    try {
      const thumb = await generateThumbnailBlob(file);
      width = thumb.width;
      height = thumb.height;
      const thumbRef = ref(storage, `users/${userId}/images/${imageId}_thumb`);
      await uploadBytes(thumbRef, thumb.blob, { contentType: 'image/png' });
    } catch (err) {
      console.warn('Thumbnail generation failed:', err);
    }

    return {
      success: true,
      image: {
        id: imageId,
        filename: file.name,
        size: file.size,
        width,
        height,
        addedAt: Date.now()
      }
    };
  } catch (error) {
    console.error('uploadImageWithThumbnail error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete an image from storage
 * @param {string} userId
 * @param {string} imageId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteImage(userId, imageId) {
  if (!isConfigured || !storage) {
    return { success: false, error: 'Firebase Storage not configured' };
  }

  const paths = [
    `users/${userId}/images/${imageId}`,
    `users/${userId}/images/${imageId}_thumb`
  ];
  const errors = [];
  for (const p of paths) {
    try {
      await deleteObject(ref(storage, p));
    } catch (error) {
      if (error.code !== 'storage/object-not-found') errors.push(error.message);
    }
  }
  return { success: errors.length === 0, errors };
}

/**
 * Convert a data URL to a Blob
 * @param {string} dataUrl
 * @returns {Blob|null} - Returns null if data URL is invalid
 */
export function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return null;
  }

  const arr = dataUrl.split(',');
  if (arr.length < 2) {
    return null;
  }

  const mimeMatch = arr[0].match(/:(.*?);/);
  if (!mimeMatch) {
    return null;
  }

  const mime = mimeMatch[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * Generate a unique image ID
 * @returns {string}
 */
export function generateImageId() {
  // Match desktop's `img-<ts>-<hex>` convention so IDs look uniform across
  // platforms and sort chronologically.
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `img-${Date.now()}-${rand}`;
}
