/**
 * Login Page
 * Handles user authentication (sign in / register)
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const { signIn, register, error, clearError, user, isConfigured } = useAuth();
  const navigate = useNavigate();

  // Handle redirects in useEffect to avoid render-time navigation
  useEffect(() => {
    if (!isConfigured) {
      navigate('/setup', { replace: true });
    } else if (user) {
      navigate('/', { replace: true });
    }
  }, [user, isConfigured, navigate]);

  // Show loading while redirecting
  if (!isConfigured || user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app-bg">
        <div className="animate-pulse text-app-text-muted">Loading...</div>
      </div>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    clearError();

    let result;
    if (isRegister) {
      result = await register(email, password, displayName);
    } else {
      result = await signIn(email, password);
    }

    setLoading(false);

    if (result.success) {
      navigate('/', { replace: true });
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    clearError();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-app-bg">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📝</div>
          <h1 className="text-2xl font-semibold text-app-text">
            Prompt Library
          </h1>
          <p className="text-app-text-muted text-sm mt-1">
            {isRegister ? 'Create your account' : 'Sign in to continue'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <div>
              <label className="block text-sm text-app-text-muted mb-1">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="w-full px-4 py-3 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent transition-colors"
              />
            </div>
          )}

          <div>
            <label className="block text-sm text-app-text-muted mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full px-4 py-3 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm text-app-text-muted mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full px-4 py-3 bg-app-surface border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent transition-colors"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-900/30 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-app-accent hover:bg-app-accent-hover text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Please wait...' : (isRegister ? 'Create Account' : 'Sign In')}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={toggleMode}
            className="text-app-accent hover:underline text-sm"
          >
            {isRegister
              ? 'Already have an account? Sign in'
              : "Don't have an account? Register"}
          </button>
        </div>
      </div>
    </div>
  );
}
