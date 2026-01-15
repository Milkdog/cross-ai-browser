/**
 * Firebase Configuration
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.firebase.google.com/
 * 2. Create a new project (or use existing)
 * 3. Enable Authentication > Email/Password provider
 * 4. Enable Firestore Database
 * 5. Enable Storage (for images)
 * 6. Go to Project Settings > General > Your apps > Add web app
 * 7. Copy the firebaseConfig values below
 */

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyCb1dAdSm_Xx3y1qDuMB3xSgO9Zd_FG6nQ",
  authDomain: "prompt-library-pwa.firebaseapp.com",
  projectId: "prompt-library-pwa",
  storageBucket: "prompt-library-pwa.firebasestorage.app",
  messagingSenderId: "636149115447",
  appId: "1:636149115447:web:d51e36784660a22ee0adb2"
};

// Check if Firebase is configured
const isConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";

let app = null;
let auth = null;
let db = null;
let storage = null;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

export { app, auth, db, storage, isConfigured };
