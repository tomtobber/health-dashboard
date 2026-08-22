import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught React client error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-primary, #090d16)',
          color: 'var(--text-primary, #f8fafc)',
          padding: '2rem',
          fontFamily: 'Inter, system-ui, sans-serif',
          textAlign: 'center'
        }}>
          <div className="glass-panel" style={{ padding: '2.5rem', maxWidth: '500px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <AlertTriangle size={48} color="#f43f5e" />
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Something went wrong</h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted, #94a3b8)', lineHeight: 1.5 }}>
              {this.state.error?.message || 'An unexpected client-side error occurred while rendering the dashboard.'}
            </p>
            <button
              className="btn btn-primary"
              style={{ marginTop: '0.5rem', padding: '0.5rem 1.25rem' }}
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              <RefreshCw size={16} /> Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
