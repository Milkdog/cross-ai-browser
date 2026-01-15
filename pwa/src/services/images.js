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
    console.error('Error getting image URL:', error);
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

  try {
    const storageRef = ref(storage, `users/${userId}/images/${imageId}`);
    await deleteObject(storageRef);
    return { success: true };
  } catch (error) {
    // Ignore not-found errors (image may already be deleted)
    if (error.code === 'storage/object-not-found') {
      return { success: true };
    }
    console.error('Error deleting image:', error);
    return { success: false, error: error.message };
  }
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
  return `img_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
