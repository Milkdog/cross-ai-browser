/**
 * Header Component
 * App header with search and user menu
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function Header({ user, searchQuery, onSearchChange }) {
  const { logOut } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await logOut();
    setShowMenu(false);
  };

  return (
    <header className="px-4 py-3 border-b border-app-border bg-app-surface flex items-center gap-4" style={{ paddingTop: 'max(12px, var(--sat))' }}>
      {/* Logo / Title */}
      <h1 className="text-lg font-semibold text-app-text flex-shrink-0">
        📝 Prompts
      </h1>

      {/* Search */}
      <div className="flex-1 max-w-md">
        <div className="relative">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search prompts..."
            className="w-full px-4 py-2 pl-10 bg-app-bg border border-app-border rounded-lg text-app-text placeholder-app-text-muted focus:outline-none focus:border-app-accent transition-colors text-sm"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-app-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
      </div>

      {/* User Menu */}
      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="w-8 h-8 rounded-full bg-app-accent text-white flex items-center justify-center text-sm font-medium"
        >
          {user?.displayName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || '?'}
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-2 w-48 bg-app-surface border border-app-border rounded-lg shadow-lg overflow-hidden z-50">
            <div className="px-4 py-3 border-b border-app-border">
              <p className="text-sm font-medium text-app-text truncate">
                {user?.displayName || 'User'}
              </p>
              <p className="text-xs text-app-text-muted truncate">
                {user?.email}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full px-4 py-3 text-left text-sm text-app-text hover:bg-app-bg transition-colors"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
