import React from 'react';

export default function AuthCard({ title, subtitle, points = [] }) {
  return (
    <section className="auth-copy glass-panel">
      <h1 className="font-serif auth-title">{title}</h1>
      <p className="auth-subtitle">{subtitle}</p>
      <div className="auth-points">
        {points.map((point) => (
          <div className="auth-point" key={point}>
            <span className="auth-point-dot" aria-hidden="true" />
            <span>{point}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
