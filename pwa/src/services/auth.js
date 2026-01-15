/**
 * Authentication Service
 * Handles user login, registration, and session management
 */

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'firebase/auth';
import { auth, isConfigured } from './firebase';

/**
 * Sign in with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function signIn(email, password) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return {
      success: true,
      user: {
        uid: userCredential.user.uid,
        email: userCredential.user.email,
        displayName: userCredential.user.displayName
      }
    };
  } catch (error) {
    const errorMessages = {
      'auth/invalid-credential': 'Invalid email or password',
      'auth/user-not-found': 'No account found with this email',
      'auth/wrong-password': 'Incorrect password',
      'auth/too-many-requests': 'Too many failed attempts. Please try again later',
      'auth/user-disabled': 'This account has been disabled'
    };
    return {
      success: false,
      error: errorMessages[error.code] || error.message
    };
  }
}

/**
 * Register a new user
 * @param {string} email
 * @param {string} password
 * @param {string} displayName
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function register(email, password, displayName) {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);

    // Update display name
    if (displayName) {
      await updateProfile(userCredential.user, { displayName });
    }

    return {
      success: true,
      user: {
        uid: userCredential.user.uid,
        email: userCredential.user.email,
        displayName
      }
    };
  } catch (error) {
    const errorMessages = {
      'auth/email-already-in-use': 'An account with this email already exists',
      'auth/invalid-email': 'Invalid email address',
      'auth/weak-password': 'Password should be at least 6 characters'
    };
    return {
      success: false,
      error: errorMessages[error.code] || error.message
    };
  }
}

/**
 * Sign out the current user
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function logOut() {
  if (!isConfigured) {
    return { success: false, error: 'Firebase not configured' };
  }

  try {
    await signOut(auth);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Subscribe to auth state changes
 * @param {function} callback - Called with user object or null
 * @returns {function} Unsubscribe function
 */
export function subscribeToAuth(callback) {
  if (!isConfigured) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, (user) => {
    if (user) {
      callback({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName
      });
    } else {
      callback(null);
    }
  });
}

/**
 * Get the current user
 * @returns {object|null}
 */
export function getCurrentUser() {
  if (!isConfigured || !auth.currentUser) {
    return null;
  }

  return {
    uid: auth.currentUser.uid,
    email: auth.currentUser.email,
    displayName: auth.currentUser.displayName
  };
}
