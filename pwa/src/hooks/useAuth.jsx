/**
 * useAuth Hook
 * Manages authentication state
 */

import { useState, useEffect, createContext, useContext } from 'react';
import { subscribeToAuth, signIn, register, logOut } from '../services/auth';
import { isConfigured } from '../services/firebase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeToAuth((user) => {
      setUser(user);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const handleSignIn = async (email, password) => {
    setError(null);
    const result = await signIn(email, password);
    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const handleRegister = async (email, password, displayName) => {
    setError(null);
    const result = await register(email, password, displayName);
    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const handleLogOut = async () => {
    setError(null);
    const result = await logOut();
    if (!result.success) {
      setError(result.error);
    }
    return result;
  };

  const value = {
    user,
    loading,
    error,
    isConfigured,
    signIn: handleSignIn,
    register: handleRegister,
    logOut: handleLogOut,
    clearError: () => setError(null)
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
