import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import SetupPage from './pages/SetupPage';

function ProtectedRoute({ children }) {
  const { user, loading, isConfigured } = useAuth();

  if (!isConfigured) {
    return <Navigate to="/setup" replace />;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app-bg">
        <div className="animate-pulse text-app-text-muted">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function AppRoutes() {
  const { isConfigured } = useAuth();

  return (
    <Routes>
      <Route
        path="/setup"
        element={isConfigured ? <Navigate to="/" replace /> : <SetupPage />}
      />
      <Route
        path="/login"
        element={<LoginPage />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <HomePage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <div className="min-h-screen bg-app-bg">
        <AppRoutes />
      </div>
    </AuthProvider>
  );
}
