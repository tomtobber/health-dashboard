import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { SavedViewsBar } from './components/SavedViewsBar';
import { MultiMetricPanel } from './components/MultiMetricPanel';
import { PanelConfigModal } from './components/PanelConfigModal';
import { ManualEntryModal } from './components/ManualEntryModal';
import { MetricDefinitionModal } from './components/MetricDefinitionModal';
import { BaselineModal } from './components/BaselineModal';
import { CorrelationModal } from './components/CorrelationModal';
import { AuthModal } from './components/AuthModal';
import {
  DashboardView,
  DashboardPanelConfig,
  MetricDefinition,
} from './types';
import { api, setToken } from './services/api';
import { Plus } from 'lucide-react';

const DEFAULT_PANELS: DashboardPanelConfig[] = [
  {
    id: 'panel-cardio',
    metricTypes: ['heart-rate', 'daily-resting-heart-rate', 'steps'],
    timeRange: { type: 'relative', value: 'last_7d' },
    aggregation: 'weekly_avg',
    chartType: 'line',
  },
  {
    id: 'panel-recovery',
    metricTypes: ['sleep', 'daily-heart-rate-variability'],
    timeRange: { type: 'relative', value: 'last_30d' },
    aggregation: 'weekly_avg',
    chartType: 'line',
  },
];

export const App: React.FC = () => {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [views, setViews] = useState<DashboardView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [panels, setPanels] = useState<DashboardPanelConfig[]>(DEFAULT_PANELS);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [googleStatus, setGoogleStatus] = useState('offline');

  // Modals state
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isDefOpen, setIsDefOpen] = useState(false);
  const [editingPanel, setEditingPanel] = useState<DashboardPanelConfig | null | 'new'>(null);
  const [baselineModalMetric, setBaselineModalMetric] = useState<{ metricType?: string; displayName?: string } | null>(null);
  const [correlationModalMetrics, setCorrelationModalMetrics] = useState<{ metricTypeA?: string; metricTypeB?: string } | null>(null);

  // Initialize app
  const initApp = async () => {
    try {
      const userData = await api.getCurrentUser();
      setUser(userData.user);
      loadUserData();
    } catch {
      // Not logged in or token expired
    }
  };

  const loadUserData = async () => {
    try {
      const [viewsList, defsList, accounts] = await Promise.all([
        api.listDashboardViews().catch(() => []),
        api.listMetricDefinitions(true).catch(() => []),
        api.getConnectedAccounts().catch(() => []),
      ]);

      setViews(viewsList);
      setDefinitions(defsList);

      const googleAcc = accounts.find((a) => a.provider === 'google_health');
      setGoogleStatus(googleAcc ? googleAcc.status : 'offline');

      if (viewsList.length > 0 && !activeViewId) {
        setActiveViewId(viewsList[0].id);
        setPanels(viewsList[0].config.panels);
      }
    } catch {
      // Ignored
    }
  };

  useEffect(() => {
    initApp();
    if (typeof window !== 'undefined' && window.location.search.includes('google_connected=true')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);


  const handleConnectGoogle = async () => {
    try {
      const res = await api.getGoogleAuthUrl();
      if (res && (res.authUrl || res.url)) {
        window.location.href = res.authUrl || res.url;
      }
    } catch (err: unknown) {
      console.error('Failed to get Google Auth URL:', err);
    }
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    setViews([]);
    setActiveViewId(null);
    setPanels(DEFAULT_PANELS);
  };

  const handleSelectView = (view: DashboardView) => {
    setActiveViewId(view.id);
    setPanels(view.config.panels);
  };

  const handleSaveCurrentView = async (name: string) => {
    const saved = await api.createDashboardView(name, { panels });
    setViews([...views, saved]);
    setActiveViewId(saved.id);
  };

  const handleUpdateView = async (viewId: string) => {
    const updated = await api.updateDashboardView(viewId, { config: { panels } });
    setViews(views.map((v) => (v.id === viewId ? updated : v)));
  };

  const handleDeleteView = async (viewId: string) => {
    await api.deleteDashboardView(viewId);
    const remaining = (Array.isArray(views) ? views : []).filter((v) => v.id !== viewId);
    setViews(remaining);
    if (remaining.length > 0) {
      setActiveViewId(remaining[0].id);
      setPanels(remaining[0].config.panels);
    } else {
      setActiveViewId(null);
      setPanels(DEFAULT_PANELS);
    }
  };


  const handleSeedDemoData = async () => {
    setIsSyncing(true);
    try {
      await api.seedDemoData();
      await loadUserData();
      // Trigger a refreshed panel state by shallow copying
      setPanels([...panels]);
    } catch (err: unknown) {
      console.error('Failed to seed demo data:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTriggerSync = async () => {
    setIsSyncing(true);
    try {
      await api.triggerSync('manual');
      await loadUserData();
      setTimeout(() => {
        setIsSyncing(false);
      }, 2000);
    } catch (err: unknown) {
      console.error('Manual sync failed:', err);
      await loadUserData();
      setIsSyncing(false);
    }
  };

  const handleSavePanelConfig = (config: DashboardPanelConfig) => {
    if (editingPanel === 'new') {
      setPanels([...panels, config]);
    } else if (editingPanel) {
      setPanels(panels.map((p) => (p.id === editingPanel.id ? config : p)));
    }
    setEditingPanel(null);
  };

  const handleRemovePanel = (panelId: string) => {
    setPanels((Array.isArray(panels) ? panels : []).filter((p) => p.id !== panelId));
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        onConnectGoogle={handleConnectGoogle}
        user={user}
        onOpenAuth={() => setIsAuthOpen(true)}
        onLogout={handleLogout}
        onOpenLogModal={() => setIsLogOpen(true)}
        onOpenDefModal={() => setIsDefOpen(true)}
        onAddPanel={() => setEditingPanel('new')}
        onOpenBaselines={() => setBaselineModalMetric({})}
        onOpenCorrelation={() => setCorrelationModalMetrics({})}
        onTriggerSync={handleTriggerSync}
        isSyncing={isSyncing}
        googleStatus={googleStatus}
      />

      {user && (
        <SavedViewsBar
          views={views}
          activeViewId={activeViewId}
          onSelectView={handleSelectView}
          onSaveCurrentView={handleSaveCurrentView}
          onUpdateView={handleUpdateView}
          onDeleteView={handleDeleteView}
          onNewEmptyLayout={() => {
            setActiveViewId(null);
            setPanels(DEFAULT_PANELS);
          }}
        />
      )}

      {/* Main Grid of Multi-Metric Panels */}
      <main style={{ flex: 1, padding: '0 1rem 2rem 1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        {panels.map((panel) => (
          <MultiMetricPanel
            key={panel.id}
            panel={panel}
            user={user}
            onEdit={() => setEditingPanel(panel)}
            onRemove={() => handleRemovePanel(panel.id)}
            onOpenAuth={() => setIsAuthOpen(true)}
            onSeedDemo={handleSeedDemoData}
            onOpenLog={() => setIsLogOpen(true)}
            onOpenBaseline={(metricType, displayName) => setBaselineModalMetric({ metricType, displayName })}
          />
        ))}

        {panels.length === 0 && (
          <div className="glass-panel" style={{ gridColumn: '1 / -1', padding: '3rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--text-muted)' }}>
            <h3>No Active Chart Panels</h3>
            <p style={{ fontSize: '0.875rem' }}>Add a panel to compare multiple health and lifestyle metrics on a single canvas.</p>
            <button className="btn btn-primary" onClick={() => setEditingPanel('new')}>
              <Plus size={16} /> Add Panel
            </button>
          </div>
        )}
      </main>

      {/* Modals */}
      {isAuthOpen && (
        <AuthModal
          onSuccess={(u) => {
            setUser(u);
            loadUserData();
          }}
          onClose={() => setIsAuthOpen(false)}
        />
      )}

      {isLogOpen && (
        <ManualEntryModal
          definitions={definitions}
          onSuccess={() => {
            loadUserData();
          }}
          onClose={() => setIsLogOpen(false)}
        />
      )}

      {isDefOpen && (
        <MetricDefinitionModal
          onSuccess={() => {
            loadUserData();
          }}
          onClose={() => setIsDefOpen(false)}
        />
      )}

      
      {baselineModalMetric && (
        <BaselineModal
          initialMetricType={baselineModalMetric.metricType}
          initialDisplayName={baselineModalMetric.displayName}
          onClose={() => setBaselineModalMetric(null)}
        />
      )}

      {correlationModalMetrics && (
        <CorrelationModal
          initialMetricTypeA={correlationModalMetrics.metricTypeA}
          initialMetricTypeB={correlationModalMetrics.metricTypeB}
          onClose={() => setCorrelationModalMetrics(null)}
        />
      )}

      {editingPanel && (
        <PanelConfigModal
          panel={editingPanel === 'new' ? null : editingPanel}
          definitions={definitions}
          onSave={handleSavePanelConfig}
          onClose={() => setEditingPanel(null)}
        />
      )}
    </div>
  );
};
