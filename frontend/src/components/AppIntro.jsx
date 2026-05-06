import React, { useEffect, useState } from 'react';

const INTRO_SESSION_KEY = 'atlp-home-intro-seen';

const shouldShowIntro = (enabled) => {
  if (!enabled || typeof window === 'undefined') return false;

  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const alreadySeen = window.sessionStorage.getItem(INTRO_SESSION_KEY) === 'true';
  window.sessionStorage.setItem(INTRO_SESSION_KEY, 'true');

  return !alreadySeen && !prefersReducedMotion;
};

const AppIntro = ({ enabled }) => {
  const [visible, setVisible] = useState(() => shouldShowIntro(enabled));
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;

    const leaveTimer = window.setTimeout(() => setLeaving(true), 1450);
    const doneTimer = window.setTimeout(() => setVisible(false), 1900);

    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={`app-intro${leaving ? ' is-leaving' : ''}`} role="status" aria-live="polite" aria-label="Opening After the Last Page">
      <div className="app-intro__ambient" aria-hidden="true" />
      <div className="app-intro__mark" aria-hidden="true">
        <span className="app-intro__fragment app-intro__fragment--one" />
        <span className="app-intro__fragment app-intro__fragment--two" />
        <span className="app-intro__fragment app-intro__fragment--three" />
        <span className="app-intro__fragment app-intro__fragment--four" />
        <span className="app-intro__spine" />
        <span className="app-intro__page app-intro__page--left" />
        <span className="app-intro__page app-intro__page--right" />
      </div>
      <p className="app-intro__wordmark">After the Last Page</p>
    </div>
  );
};

export default AppIntro;
