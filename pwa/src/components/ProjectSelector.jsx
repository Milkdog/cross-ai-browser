/**
 * Project Selector Component
 * Dropdown to select project or global prompts
 */

import { useState, useRef, useEffect } from 'react';

export default function ProjectSelector({
  projects,
  selectedProject,
  showGlobal,
  onSelectProject,
  onShowGlobal
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedProjectName = showGlobal
    ? 'Global'
    : projects.find(p => p.id === selectedProject)?.name || 'All Projects';

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 bg-app-bg border border-app-border rounded-lg text-sm text-app-text hover:border-app-accent transition-colors"
      >
        <span className="truncate max-w-[150px]">{selectedProjectName}</span>
        <svg
          className={`w-4 h-4 text-app-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-app-surface border border-app-border rounded-lg shadow-lg overflow-hidden z-50">
          {/* Global option */}
          <button
            onClick={() => {
              onShowGlobal();
              setIsOpen(false);
            }}
            className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-app-bg transition-colors ${
              showGlobal ? 'text-app-accent' : 'text-app-text'
            }`}
          >
            <span>🌐</span>
            <span>Global Prompts</span>
            {showGlobal && <span className="ml-auto text-app-accent">✓</span>}
          </button>

          <div className="border-t border-app-border" />

          {/* All projects option */}
          <button
            onClick={() => {
              onSelectProject(null);
              setIsOpen(false);
            }}
            className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-app-bg transition-colors ${
              !showGlobal && !selectedProject ? 'text-app-accent' : 'text-app-text'
            }`}
          >
            <span>📁</span>
            <span>All Projects</span>
            {!showGlobal && !selectedProject && <span className="ml-auto text-app-accent">✓</span>}
          </button>

          {/* Individual projects */}
          {projects.length > 0 && (
            <>
              <div className="border-t border-app-border" />
              <div className="max-h-48 overflow-y-auto">
                {projects.map(project => (
                  <button
                    key={project.id}
                    onClick={() => {
                      onSelectProject(project.id);
                      setIsOpen(false);
                    }}
                    className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-app-bg transition-colors ${
                      !showGlobal && selectedProject === project.id ? 'text-app-accent' : 'text-app-text'
                    }`}
                  >
                    <span>📂</span>
                    <span className="truncate">{project.name}</span>
                    {!showGlobal && selectedProject === project.id && (
                      <span className="ml-auto text-app-accent flex-shrink-0">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {projects.length === 0 && (
            <div className="px-4 py-3 text-sm text-app-text-muted">
              No projects synced yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}
