import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, Menu, Moon, Palette, Sun, X } from 'lucide-react';
import { UI_THEMES } from '../../utils/uiThemes';
import './Navbar.css';

const NAV_ITEMS = [
  { path: '/desk', label: 'Your desk' },
  { path: '/library', label: 'Library' },
  { path: '/meet', label: 'Meet' },
  { path: '/threads', label: 'Threads' },
  { path: '/merch', label: 'Studio' },
];

const THEME_SWATCH = {
  light: '#ffffff',
  sepia: '#E8DCC7',
  dark: '#1E2230',
};

const ProfileAvatar = ({ user, className = '', onClick, label = 'Open profile' }) => {
  const [failedImageUrl, setFailedImageUrl] = useState('');
  const profileImageUrl = user?.profileImageUrl || '';
  const displayName = user?.name || user?.username || user?.email || user?.anonymousId || 'Reader';
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'R';

  const imageFailed = Boolean(profileImageUrl) && failedImageUrl === profileImageUrl;

  const avatarContent = profileImageUrl && !imageFailed ? (
    <img
      src={profileImageUrl}
      alt={`${displayName} profile`}
      className="nav-avatar-image"
      onError={() => setFailedImageUrl(profileImageUrl)}
      loading="lazy"
    />
  ) : (
    <span className="nav-avatar-fallback" aria-hidden="true">{initials}</span>
  );

  return (
    <button type="button" className={`nav-avatar-btn ${className}`.trim()} onClick={onClick} aria-label={label}>
      {avatarContent}
    </button>
  );
};

const Navbar = ({ currentUser, onLogout, uiTheme, onThemeChange }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);

  const activeTheme = useMemo(() => UI_THEMES.find((theme) => theme.id === uiTheme) || UI_THEMES[0], [uiTheme]);

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!profileMenuOpen) return undefined;

    const handleClickOutside = (event) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setProfileMenuOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [profileMenuOpen]);

  const handleViewProfile = () => {
    setProfileMenuOpen(false);
    navigate('/profile');
  };

  const isMember = Boolean(currentUser && !currentUser.isAnonymous);

  const handleSignOut = async () => {
    setProfileMenuOpen(false);
    setDrawerOpen(false);
    await onLogout?.();
    navigate('/');
  };

  const cycleTheme = () => {
    const themeOrder = ['dark', 'sepia', 'light'];
    const currentIndex = Math.max(themeOrder.indexOf(uiTheme), 0);
    const nextTheme = themeOrder[(currentIndex + 1) % themeOrder.length];
    onThemeChange(nextTheme);
  };

  return (
    <>
      <header className="navbar" aria-label="Global">
        <div className="navbar-left">
          <Link to="/" className="navbar-brand-link" aria-label="After the Last Page home">
            <span className="navbar-title font-serif">After the Last Page</span>
          </Link>
        </div>

        <nav className="center-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const active = location.pathname.startsWith(item.path);
            return (
              <Link key={item.path} to={item.path} className={`center-nav-link ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="navbar-right">
          <div className="right-controls">
            <button
              type="button"
              className="theme-icon-btn"
              onClick={cycleTheme}
              aria-label={`Switch theme. Current theme: ${activeTheme.label}`}
            >
              {uiTheme === 'dark' ? <Sun size={17} /> : uiTheme === 'sepia' ? <Palette size={17} /> : <Moon size={17} />}
            </button>

            {isMember ? (
              <div className="profile-menu-wrap" ref={profileMenuRef}>
                <ProfileAvatar
                  user={currentUser}
                  label="Open profile menu"
                  onClick={() => setProfileMenuOpen((open) => !open)}
                />
                {profileMenuOpen ? (
                  <div className="profile-dropdown" role="menu" aria-label="Profile menu">
                    <button type="button" className="profile-dropdown-item" role="menuitem" onClick={handleViewProfile}>View profile</button>
                    <button type="button" className="profile-dropdown-item is-danger" role="menuitem" onClick={handleSignOut}>
                      Sign out
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="guest-auth-controls">
                <button type="button" className="btn-primary sm" onClick={() => navigate('/auth')}>
                  Enter
                </button>
              </div>
            )}
          </div>

          {isMember ? (
            <ProfileAvatar user={currentUser} className="mobile-menu-avatar" onClick={() => setDrawerOpen(true)} label="Open navigation menu" />
          ) : (
            <button type="button" className="mobile-menu-trigger" onClick={() => setDrawerOpen(true)} aria-label="Open navigation menu">
              <Menu size={18} />
            </button>
          )}
        </div>
      </header>

      <aside className={`mobile-drawer ${drawerOpen ? 'is-open' : ''}`} aria-hidden={!drawerOpen}>
        <div className="mobile-drawer-panel" role="dialog" aria-modal="true" aria-label="Navigation drawer">
          <header className="drawer-header">
            <span className="drawer-brand font-serif">After the Last Page</span>
            <button type="button" className="drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
              <X size={20} />
            </button>
          </header>

          <div className="drawer-avatar-wrap">
            {isMember ? <ProfileAvatar user={currentUser} className="drawer-avatar" onClick={() => setDrawerOpen(false)} /> : <span className="drawer-guest-label">Guest</span>}
          </div>

          <nav className="drawer-nav" aria-label="Mobile navigation">
            {NAV_ITEMS.map((item) => {
              const active = location.pathname.startsWith(item.path);
              return (
                <Link key={item.path} to={item.path} className={`drawer-nav-row ${active ? 'is-active' : ''}`} onClick={() => setDrawerOpen(false)}>
                  <span>{item.label}</span>
                  <ChevronRight size={18} aria-hidden="true" />
                </Link>
              );
            })}
          </nav>

          <div className="drawer-bottom">
            <div className="drawer-theme-group" role="group" aria-label="Theme">
              {UI_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`drawer-theme-swatch ${uiTheme === theme.id ? 'is-active' : ''}`}
                  onClick={() => onThemeChange(theme.id)}
                  aria-label={`Switch to ${theme.label} theme`}
                >
                  <span className="drawer-theme-dot" style={{ background: THEME_SWATCH[theme.id] }} aria-hidden="true" />
                  <span>{theme.label}</span>
                </button>
              ))}
            </div>

            {isMember ? (
              <button type="button" className="drawer-action-row is-danger" onClick={handleSignOut}>Sign out</button>
            ) : (
              <button type="button" className="drawer-action-row" onClick={() => { setDrawerOpen(false); navigate('/auth'); }}>Enter</button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

export default Navbar;

