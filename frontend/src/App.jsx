import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HashRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/layout/Navbar';
import AppIntro from './components/AppIntro';
import SessionNavigationGuard from './components/session/SessionNavigationGuard';
import PrivateRoute from './components/auth/PrivateRoute';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import api from './utils/api';
import { clearAuthSession, getStoredToken, getStoredUser, saveAuthSession, updateStoredUser } from './utils/auth';
import { getOrCreateIdentity } from './utils/identity';
import { DEFAULT_UI_THEME, THEME_STORAGE_KEY, UI_THEMES } from './utils/uiThemes';
import { applyThemeTokens } from './styles/theme';
import './index.css';
import OnboardingModal from './components/OnboardingModal';

const VALID_THEMES = UI_THEMES.map((theme) => theme.id);

const LandingPage = lazy(() => import('./pages/LandingPage'));
const MeetingAccessHub = lazy(() => import('./pages/MeetingAccessHub'));
const ReadingRoom = lazy(() => import('./pages/ReadingRoom'));
const MeetingHub = lazy(() => import('./pages/MeetingHub'));
const BookThread = lazy(() => import('./pages/BookThread'));
const ThreadAccessHub = lazy(() => import('./pages/ThreadAccessHub'));
const WizardMerch = lazy(() => import('./pages/WizardMerch'));
const RequestBookPage = lazy(() => import('./pages/RequestBookPage'));

const AuthPage = lazy(() => import('./pages/AuthPage'));
const BooksLibrary = lazy(() => import('./pages/BooksLibrary'));
const Library = lazy(() => import('./pages/Library'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));

const buildGuestUser = () => {
  const identity = getOrCreateIdentity();
  if (!identity) return null;

  return {
    _id: identity.userId,
    anonymousId: identity.displayName,
    displayName: identity.displayName,
    isAnonymous: true,
  };
};

const AppShell = ({ currentUser, onLogout, onUserUpdate, uiTheme, onThemeChange, onAuthSuccess }) => {
  const location = useLocation();
  const hideNavbar = location.pathname.startsWith('/read/');
  const showHomeIntro = location.pathname === '/';

  return (
    <div className="app-container">
      {showHomeIntro && <AppIntro key={location.key} enabled />}
      <SessionNavigationGuard />
      {!hideNavbar && (
        <Navbar currentUser={currentUser} onLogout={onLogout} uiTheme={uiTheme} onThemeChange={onThemeChange} />
      )}
      <main className={`main-content ${hideNavbar ? 'no-navbar' : 'with-navbar'}`}>
        <Suspense fallback={<div className="route-skeleton" aria-hidden="true" />}>
          <Routes>
            <Route path="/" element={<LandingPage currentUser={currentUser} />} />
            <Route path="/auth" element={<AuthPage currentUser={currentUser} onAuthSuccess={onAuthSuccess} />} />
            <Route path="/desk" element={<PrivateRoute><BooksLibrary currentUser={currentUser} /></PrivateRoute>} />
            <Route path="/library" element={<PrivateRoute><Library currentUser={currentUser} /></PrivateRoute>} />
            <Route path="/profile" element={<PrivateRoute><ProfilePage currentUser={currentUser} onUserUpdate={onUserUpdate} /></PrivateRoute>} />

            <Route path="/meet" element={<MeetingAccessHub currentUser={currentUser} />} />
            <Route path="/threads" element={<ThreadAccessHub currentUser={currentUser} />} />
            <Route path="/request-book" element={<RequestBookPage />} />
            <Route path="/read" element={<Navigate to="/request-book" replace />} />
            <Route path="/read/gutenberg/:gutenbergId" element={<ReadingRoom uiTheme={uiTheme} onThemeChange={onThemeChange} />} />
            <Route path="/read/:bookId" element={<ReadingRoom uiTheme={uiTheme} onThemeChange={onThemeChange} />} />
            <Route path="/meet/:bookId" element={<MeetingHub />} />
            <Route path="/thread/:bookId" element={<BookThread />} />
            <Route path="/merch" element={<WizardMerch />} />

            <Route path="/settings" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <OnboardingModal />
      </main>
    </div>
  );
};

const App = () => {
  const [currentUser, setCurrentUser] = useState(() => getStoredUser() || buildGuestUser());
  const [authLoading, setAuthLoading] = useState(() => Boolean(getStoredToken()));
  const bootstrapStartedRef = useRef(false);
  const [uiTheme, setUiTheme] = useState(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === 'midnight' || storedTheme === 'mocha') {
      return DEFAULT_UI_THEME;
    }

    return VALID_THEMES.includes(storedTheme) ? storedTheme : DEFAULT_UI_THEME;
  });

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;

    const token = getStoredToken();
    if (!token) {
      setAuthLoading(false);
      return;
    }

    const bootstrap = async () => {
      try {
        const { data } = await api.get('/auth/me');
        const user = saveAuthSession({ ...(data || {}), token }) || data;
        setCurrentUser(user || buildGuestUser());
      } catch {
        clearAuthSession();
        setCurrentUser(buildGuestUser());
      } finally {
        setAuthLoading(false);
      }
    };

    bootstrap();
  }, []);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        if (window.location.hash.startsWith('#/') && window.location.pathname !== '/') {
          window.history.replaceState(null, '', `/${window.location.hash}`);
          return;
        }

        if (!window.location.hash && window.location.pathname && window.location.pathname !== '/') {
          const search = window.location.search || '';
          const nextHash = `#${window.location.pathname}${search}`;
          window.history.replaceState(null, '', `/${nextHash}`);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, uiTheme);
    applyThemeTokens(uiTheme);
  }, [uiTheme]);

  const handleAuthSuccess = useCallback((user) => {
    setCurrentUser(user || buildGuestUser());
  }, []);

  const handleUserUpdate = useCallback((userPatch) => {
    const nextUser = updateStoredUser(userPatch) || userPatch;
    setCurrentUser((prev) => ({ ...(prev || {}), ...(nextUser || {}) }));
  }, []);

  const handleLogout = useCallback(async () => {
    clearAuthSession();
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore
    }
    setCurrentUser(buildGuestUser());
  }, []);

  const authContextValue = useMemo(() => ({
    currentUser,
    setCurrentUser,
    authLoading,
  }), [authLoading, currentUser]);

  return (
    <AuthProvider value={authContextValue}>
      <SocketProvider currentUser={currentUser}>
        <Router>
          <AppShell
            currentUser={currentUser}
            onLogout={handleLogout}
            onUserUpdate={handleUserUpdate}
            uiTheme={uiTheme}
            onThemeChange={setUiTheme}
            onAuthSuccess={handleAuthSuccess}
          />
        </Router>
      </SocketProvider>
    </AuthProvider>
  );
};

export default App;
