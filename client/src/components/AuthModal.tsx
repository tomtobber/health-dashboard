import React, { useState } from 'react';
import { api } from '../services/api';
import { X, LogIn } from 'lucide-react';

interface AuthModalProps {
  onSuccess: (user: { id: string; email: string }) => void;
  onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onSuccess, onClose }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('password123');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const res = isRegister
        ? await api.register(email, password)
        : await api.login(email, password);
      onSuccess(res.user);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2>{isRegister ? 'Create Account' : 'Sign In'}</h2>
          <button className="btn btn-secondary btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {error && (
          <div style={{ padding: '0.625rem', background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(244,63,94,0.3)', borderRadius: '8px', color: '#f43f5e', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Email
            </label>
            <input
              type="email"
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.375rem' }}>
              Password
            </label>
            <input
              type="password"
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem' }}
              onClick={() => setIsRegister(!isRegister)}
            >
              {isRegister ? 'Already have an account? Sign In' : 'Need an account? Register'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              <LogIn size={15} /> {isSubmitting ? 'Authenticating...' : isRegister ? 'Register' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
