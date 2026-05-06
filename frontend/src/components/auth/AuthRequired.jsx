import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './AuthRequired.css';

export default function AuthRequired({ previewClassName = '', previewLabel = 'Preview unavailable until sign in' }) {
  const navigate = useNavigate();

  return (
    <div className="auth-required-page animate-fade-in">
      <div className={`auth-required-preview ${previewClassName}`.trim()} aria-hidden="true" role="presentation" />
      <section className="auth-required-card glass-panel" aria-label="Authentication required">
        <h1 className="font-serif">Start building your reading space</h1>
        <p>Sign in to track books, see recommendations, and join discussions.</p>
        <div className="auth-required-actions">
          <button type="button" className="btn-primary" onClick={() => navigate('/auth?mode=login')}>Login <ArrowRight size={16} /></button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/auth?mode=signup')}>Sign up</button>
        </div>
        {previewLabel ? <span className="auth-required-footnote">{previewLabel}</span> : null}
      </section>
    </div>
  );
}
