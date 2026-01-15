/**
 * Setup Page
 * Shows when Firebase is not configured
 */

export default function SetupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-app-bg">
      <div className="max-w-lg w-full">
        <div className="text-center mb-8">
          <div className="text-4xl mb-4">⚙️</div>
          <h1 className="text-2xl font-semibold text-app-text mb-2">
            Firebase Setup Required
          </h1>
          <p className="text-app-text-muted">
            Please configure Firebase to use the Prompt Library PWA
          </p>
        </div>

        <div className="bg-app-surface rounded-lg p-6 border border-app-border">
          <h2 className="font-medium text-app-text mb-4">Setup Instructions:</h2>

          <ol className="space-y-4 text-sm text-app-text-muted">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">1</span>
              <span>Go to <a href="https://console.firebase.google.com/" target="_blank" rel="noopener noreferrer" className="text-app-accent hover:underline">Firebase Console</a> and create a new project</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">2</span>
              <span>Enable <strong className="text-app-text">Authentication</strong> with Email/Password provider</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">3</span>
              <span>Enable <strong className="text-app-text">Firestore Database</strong></span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">4</span>
              <span>Enable <strong className="text-app-text">Storage</strong> (for images)</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">5</span>
              <span>Go to Project Settings → Your apps → Add web app</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-app-accent text-white flex items-center justify-center text-xs font-medium">6</span>
              <span>Copy the config values to <code className="bg-app-bg px-1 rounded">pwa/src/services/firebase.js</code></span>
            </li>
          </ol>
        </div>

        <div className="mt-6 p-4 bg-app-surface rounded-lg border border-app-border">
          <h3 className="font-medium text-app-text mb-2 text-sm">Example Config:</h3>
          <pre className="text-xs text-app-text-muted overflow-x-auto">
{`const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};`}
          </pre>
        </div>

        <p className="mt-6 text-center text-sm text-app-text-muted">
          After updating the config, refresh this page
        </p>
      </div>
    </div>
  );
}
