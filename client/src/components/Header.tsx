import React from 'react';
import { Activity, PlusCircle, PenTool, RefreshCw, LogIn, LogOut, LayoutGrid } from 'lucide-react';

interface HeaderProps {
  user: { id: string; email: string } | null;
  onOpenAuth: () => void;
  onLogout: () => void;
  onOpenLogModal: () => void;
  onOpenDefModal: () => void;
  onAddPanel: () => void;
  onTriggerSync: () => void;
  onConnectGoogle?: () => void;
  isSyncing: boolean;
  googleStatus: string;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onOpenAuth,
  onLogout,
  onOpenLogModal,
  onOpenDefModal,
  onAddPanel,
  onTriggerSync,
  onConnectGoogle,
  isSyncing,
  googleStatus,
}) => {
  return (
    <header className="glass-panel" style={{ margin: '1rem', padding: '0.875rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #6366f1, #06b6d4)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(99,102,241,0.4)' }}>
          <Activity size={22} color="#ffffff" />
        </div>
        <div>
          <h1 style={{ fontSize: '1.25rem', lineHeight: '1.2' }}>Health Dashboard</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Multi-Metric Analytics</span>
            <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--text-muted)' }}></span>
            <button
              type="button"
              onClick={googleStatus === 'active' ? onTriggerSync : onConnectGoogle}
              style={{
                fontSize: '0.75rem',
                color: googleStatus === 'active' ? '#10b981' : '#f59e0b',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                background: googleStatus === 'active' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
                border: '1px solid',
                borderColor: googleStatus === 'active' ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)',
                borderRadius: '6px',
                padding: '2px 8px',
                cursor: 'pointer',
              }}
              title={googleStatus === 'active' ? 'Google Health connected (Click to sync)' : 'Click to connect Google Health'}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: googleStatus === 'active' ? '#10b981' : '#f59e0b' }}></span>
              Google: {googleStatus === 'active' ? 'Connected' : 'Offline / Click to Connect'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
        {user ? (
          <>
            <button className="btn btn-secondary" onClick={onTriggerSync} disabled={isSyncing} title="Trigger Google Health sync">
              <RefreshCw size={15} className={isSyncing ? 'spin-anim' : ''} />
              <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>
            </button>
            <button className="btn btn-secondary" onClick={onOpenDefModal}>
              <PenTool size={15} />
              <span>+ Metric</span>
            </button>
            <button className="btn btn-primary" onClick={onOpenLogModal}>
              <PlusCircle size={15} />
              <span>Log Entry</span>
            </button>
            <button className="btn btn-secondary" onClick={onAddPanel}>
              <LayoutGrid size={15} />
              <span>Add Panel</span>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem', paddingLeft: '0.75rem', borderLeft: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{user.email}</span>
              <button className="btn btn-secondary btn-icon" onClick={onLogout} title="Sign Out">
                <LogOut size={16} />
              </button>
            </div>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onOpenAuth}>
            <LogIn size={15} />
            <span>Sign In / Demo</span>
          </button>
        )}
      </div>
    </header>
  );
};
