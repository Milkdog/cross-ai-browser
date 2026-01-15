# Prompt Library PWA

A Progressive Web App companion for managing Claude Code prompts from your iPhone or any device.

## Features

- Full CRUD operations for prompts
- Real-time sync with Firebase
- Project-based organization
- Label filtering
- Favorites and status tracking (Testing, Done)
- Works offline (PWA)

## Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project
3. Enable the following services:
   - **Authentication** > Email/Password provider
   - **Firestore Database**
   - **Storage** (for images)

### 2. Configure Firebase

1. In Firebase Console, go to Project Settings > Your apps > Add web app
2. Copy the config values
3. Edit `src/services/firebase.js` and replace the placeholder config:

```javascript
const firebaseConfig = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### 3. Deploy Firestore Rules

In Firebase Console > Firestore > Rules, paste the contents of `firestore.rules`.

### 4. Deploy Storage Rules

In Firebase Console > Storage > Rules, paste the contents of `storage.rules`.

### 5. Install Dependencies

```bash
cd pwa
npm install
```

### 6. Run Development Server

```bash
npm run dev
```

Open http://localhost:3000

### 7. Build for Production

```bash
npm run build
```

## Deploy to Firebase Hosting

1. Install Firebase CLI:
```bash
npm install -g firebase-tools
```

2. Login to Firebase:
```bash
firebase login
```

3. Initialize hosting:
```bash
firebase init hosting
```
- Select your project
- Use `dist` as public directory
- Configure as single-page app: Yes
- Don't overwrite index.html

4. Deploy:
```bash
npm run build
firebase deploy --only hosting
```

## Install as PWA on iPhone

1. Open the deployed URL in Safari
2. Tap the Share button
3. Tap "Add to Home Screen"
4. Tap "Add"

The app will now appear on your home screen and work offline.

## Syncing with Desktop App

The desktop Electron app includes a `FirebaseSyncAdapter` that can sync local prompts with Firebase. To enable:

1. Configure Firebase in the Electron app settings
2. Sign in with the same email/password
3. Enable sync for your projects

Sync is bidirectional - changes made on either device will sync to the other.
