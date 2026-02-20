/**
 * Home Page
 * Main prompts management interface
 */

import { useState, useMemo, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { usePrompts } from '../hooks/usePrompts';
import Header from '../components/Header';
import PromptCard from '../components/PromptCard';
import PromptModal from '../components/PromptModal';
import ProjectSelector from '../components/ProjectSelector';

// Persist project selection to localStorage
function loadPersistedProject() {
  try {
    const saved = localStorage.getItem('selectedProject');
    if (saved) return JSON.parse(saved);
  } catch {}
  return { selectedProject: null, showGlobal: false };
}

function persistProject(selectedProject, showGlobal) {
  try {
    localStorage.setItem('selectedProject', JSON.stringify({ selectedProject, showGlobal }));
  } catch {}
}

export default function HomePage() {
  const { user } = useAuth();
  const persisted = loadPersistedProject();
  const [selectedProject, setSelectedProjectState] = useState(persisted.selectedProject);
  const [showGlobal, setShowGlobalState] = useState(persisted.showGlobal);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLabel, setSelectedLabel] = useState(null);
  const [editingPrompt, setEditingPrompt] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const setSelectedProject = useCallback((id) => {
    setSelectedProjectState(id);
    setShowGlobalState(false);
    persistProject(id, false);
  }, []);

  const setShowGlobal = useCallback((val) => {
    setShowGlobalState(val);
    if (val) {
      setSelectedProjectState(null);
      persistProject(null, true);
    }
  }, []);

  const isAllProjects = !showGlobal && !selectedProject;
  const canCreate = !isAllProjects;

  const {
    prompts,
    projects,
    loading,
    organizedPrompts,
    getAllLabels,
    createPrompt,
    updatePrompt,
    deletePrompt,
    toggleFavorite,
    markAsDone,
    markAsTesting,
    restorePrompt
  } = usePrompts(showGlobal ? '__global__' : selectedProject);

  const { reusable, regular, testing, done } = organizedPrompts();
  const allLabels = getAllLabels();

  // Filter prompts by search and label
  const filterPrompts = (promptList) => {
    return promptList.filter(p => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = p.title?.toLowerCase().includes(query);
        const matchesContent = p.prompt?.toLowerCase().includes(query);
        if (!matchesTitle && !matchesContent) return false;
      }

      // Label filter
      if (selectedLabel) {
        if (!p.labels?.includes(selectedLabel)) return false;
      }

      return true;
    });
  };

  const filteredReusable = filterPrompts(reusable);
  const filteredRegular = filterPrompts(regular);
  const filteredTesting = filterPrompts(testing);
  const filteredDone = filterPrompts(done);

  const hasPrompts = prompts.length > 0;
  const hasFilteredPrompts = filteredReusable.length + filteredRegular.length + filteredTesting.length + filteredDone.length > 0;

  const handleNewPrompt = () => {
    setEditingPrompt(null);
    setShowModal(true);
  };

  const handleEdit = (prompt) => {
    setEditingPrompt(prompt);
    setShowModal(true);
  };

  const handleSave = async (promptData) => {
    if (editingPrompt) {
      await updatePrompt(editingPrompt.id, promptData);
    } else {
      await createPrompt(promptData);
    }
    setShowModal(false);
    setEditingPrompt(null);
  };

  const handleDelete = async (promptId) => {
    if (window.confirm('Delete this prompt?')) {
      await deletePrompt(promptId);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-app-bg">
      <Header
        user={user}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Filters Bar */}
      <div className="px-4 py-3 border-b border-app-border bg-app-surface">
        <div className="flex items-center gap-3">
          <ProjectSelector
            projects={projects}
            selectedProject={selectedProject}
            showGlobal={showGlobal}
            onSelectProject={(id) => {
              setSelectedProject(id);
            }}
            onShowGlobal={() => {
              setShowGlobal(true);
            }}
          />

          {allLabels.length > 0 && (
            <>
              <div className="w-px h-6 bg-app-border flex-shrink-0" />
              <div className="flex gap-2 overflow-x-auto pb-1 flex-1 min-w-0">
                {allLabels.map(label => (
                  <button
                    key={label}
                    onClick={() => setSelectedLabel(selectedLabel === label ? null : label)}
                    className={`px-3 py-1 rounded-full text-sm transition-colors flex-shrink-0 ${
                      selectedLabel === label
                        ? 'bg-app-accent text-white'
                        : 'bg-app-bg text-app-text-muted hover:bg-app-border'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-pulse text-app-text-muted">Loading prompts...</div>
          </div>
        ) : !hasPrompts ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="text-4xl mb-4">{isAllProjects ? '📁' : '📝'}</div>
            <p className="text-app-text-muted mb-4">
              {isAllProjects ? 'Select a project to create prompts' : 'No prompts yet'}
            </p>
            {canCreate && (
              <button
                onClick={handleNewPrompt}
                className="px-4 py-2 bg-app-accent hover:bg-app-accent-hover text-white rounded-lg transition-colors"
              >
                Create your first prompt
              </button>
            )}
          </div>
        ) : !hasFilteredPrompts ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="text-4xl mb-4">🔍</div>
            <p className="text-app-text-muted">No prompts match your filters</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Reusable Section */}
            {filteredReusable.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-emerald-400 mb-3">
                  REUSABLE ({filteredReusable.length})
                </h2>
                <div className="space-y-2">
                  {filteredReusable.map(prompt => (
                    <PromptCard
                      key={prompt.id}
                      prompt={prompt}
                      compact
                      onEdit={() => handleEdit(prompt)}
                      onDelete={() => handleDelete(prompt.id)}
                      onToggleFavorite={() => toggleFavorite(prompt.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Regular Section */}
            {filteredRegular.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-app-text-muted mb-3">
                  PROMPTS ({filteredRegular.length})
                </h2>
                <div className="space-y-2">
                  {filteredRegular.map(prompt => (
                    <PromptCard
                      key={prompt.id}
                      prompt={prompt}
                      onEdit={() => handleEdit(prompt)}
                      onDelete={() => handleDelete(prompt.id)}
                      onToggleFavorite={() => toggleFavorite(prompt.id)}
                      onMarkDone={() => markAsDone(prompt.id)}
                      onMarkTesting={() => markAsTesting(prompt.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Testing Section */}
            {filteredTesting.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-yellow-500 mb-3 flex items-center gap-2">
                  <span>🧪</span> TESTING ({filteredTesting.length})
                </h2>
                <div className="space-y-2">
                  {filteredTesting.map(prompt => (
                    <PromptCard
                      key={prompt.id}
                      prompt={prompt}
                      onEdit={() => handleEdit(prompt)}
                      onDelete={() => handleDelete(prompt.id)}
                      onToggleFavorite={() => toggleFavorite(prompt.id)}
                      onMarkDone={() => markAsDone(prompt.id)}
                      onRestore={() => restorePrompt(prompt.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Done Section */}
            {filteredDone.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-app-text-muted mb-3 flex items-center gap-2">
                  <span>✓</span> DONE ({filteredDone.length})
                </h2>
                <div className="space-y-2 opacity-60">
                  {filteredDone.map(prompt => (
                    <PromptCard
                      key={prompt.id}
                      prompt={prompt}
                      onEdit={() => handleEdit(prompt)}
                      onDelete={() => handleDelete(prompt.id)}
                      onRestore={() => restorePrompt(prompt.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* FAB - only show when a specific project or global is selected */}
      {canCreate && (
        <button
          onClick={handleNewPrompt}
          className="fixed bottom-6 right-6 w-14 h-14 bg-app-accent hover:bg-app-accent-hover text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-transform hover:scale-105 active:scale-95"
          style={{ marginBottom: 'var(--sab)' }}
        >
          +
        </button>
      )}

      {/* Modal */}
      {showModal && (
        <PromptModal
          prompt={editingPrompt}
          allLabels={allLabels}
          onSave={handleSave}
          onClose={() => {
            setShowModal(false);
            setEditingPrompt(null);
          }}
        />
      )}
    </div>
  );
}
