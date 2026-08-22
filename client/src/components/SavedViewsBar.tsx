import React, { useState } from 'react';
import { DashboardView } from '../types';
import { Bookmark, Trash2, Plus, Check } from 'lucide-react';

interface SavedViewsBarProps {
  views: DashboardView[];
  activeViewId: string | null;
  onSelectView: (view: DashboardView) => void;
  onSaveCurrentView: (name: string) => Promise<void>;
  onUpdateView: (viewId: string) => Promise<void>;
  onDeleteView: (viewId: string) => Promise<void>;
  onNewEmptyLayout: () => void;
}

export const SavedViewsBar: React.FC<SavedViewsBarProps> = ({
  views,
  activeViewId,
  onSelectView,
  onSaveCurrentView,
  onUpdateView,
  onDeleteView,
  onNewEmptyLayout,
}) => {
  const [isSavingNew, setIsSavingNew] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newViewName.trim()) return;
    setIsSubmitting(true);
    try {
      await onSaveCurrentView(newViewName.trim());
      setNewViewName('');
      setIsSavingNew(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeView = views.find((v) => v.id === activeViewId);

  return (
    <div className="glass-panel" style={{ margin: '0 1rem 1.25rem 1rem', padding: '0.75rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <Bookmark size={14} color="var(--accent-primary)" /> Views:
        </span>
        <button
          className={`btn ${activeViewId === null ? 'btn-primary' : 'btn-secondary'}`}
          style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }}
          onClick={onNewEmptyLayout}
        >
          Custom Workspace
        </button>
        {views.map((view) => (
          <button
            key={view.id}
            className={`btn ${view.id === activeViewId ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.8125rem', padding: '0.35rem 0.75rem' }}
            onClick={() => onSelectView(view)}
          >
            {view.name}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {activeView && (
          <>
            <button
              className="btn btn-secondary"
              style={{ fontSize: '0.8125rem', padding: '0.35rem 0.65rem' }}
              onClick={() => onUpdateView(activeView.id)}
              title="Save current layout changes to this view"
            >
              <Check size={14} /> Update View
            </button>
            <button
              className="btn btn-danger btn-icon"
              onClick={() => onDeleteView(activeView.id)}
              title="Delete this saved view"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}

        {isSavingNew ? (
          <form onSubmit={handleSaveSubmit} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <input
              type="text"
              className="input-field"
              style={{ width: '160px', padding: '0.35rem 0.6rem', fontSize: '0.8125rem' }}
              placeholder="View name..."
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '0.35rem 0.6rem', fontSize: '0.8125rem' }} disabled={isSubmitting}>
              Save
            </button>
            <button type="button" className="btn btn-secondary" style={{ padding: '0.35rem 0.6rem', fontSize: '0.8125rem' }} onClick={() => setIsSavingNew(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.8125rem', padding: '0.35rem 0.65rem' }}
            onClick={() => setIsSavingNew(true)}
          >
            <Plus size={14} /> Save As View
          </button>
        )}
      </div>
    </div>
  );
};
