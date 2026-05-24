const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeConfiguredUrl = (value, fallbackPath) => {
  const configured = asTrimmedString(value);
  if (!configured) {
    return fallbackPath;
  }

  if (/^https?:\/\//i.test(configured) || configured.startsWith('/')) {
    return configured;
  }

  // Accept host-like values such as "alp-api.onrender.com/api" without forcing a relative path.
  if (/^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(configured)) {
    const isLocalHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/.*)?$/i.test(configured);
    return `${isLocalHost ? 'http' : 'https'}://${configured}`;
  }

  return `/${configured}`;
};

const inferRenderCompanionHost = (hostname, fromSuffix, toSuffix) => {
  if (!hostname || !hostname.endsWith(fromSuffix)) {
    return null;
  }

  return `${hostname.slice(0, -fromSuffix.length)}${toSuffix}`;
};

export const getApiBaseUrl = () => {
  const configured = normalizeConfiguredUrl(import.meta.env.VITE_API_URL, null);
  if (configured) {
    return configured;
  }

  const isLocalHost = typeof window !== 'undefined'
    && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(String(window.location?.hostname || ''));

  // In local development (including local previews), prefer an explicit backend URL
  // to avoid relying on frontend server proxy wiring.
  if (import.meta.env.DEV || isLocalHost) {
    const devBackend = normalizeConfiguredUrl(import.meta.env.VITE_DEV_BACKEND_URL, null)
      || 'http://127.0.0.1:10000';
    return `${devBackend.replace(/\/$/, '')}/api`;
  }

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const companionHost = inferRenderCompanionHost(window.location.hostname, '-web.onrender.com', '-api.onrender.com');
    if (companionHost) {
      return `${window.location.protocol}//${companionHost}/api`;
    }

    return '/api';
  }

  return '/api';
};

export const getSocketServerUrl = () => {
  const configured = normalizeConfiguredUrl(import.meta.env.VITE_SOCKET_URL, null);
  if (configured) {
    return configured;
  }

  if (import.meta.env.DEV && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const companionHost = inferRenderCompanionHost(window.location.hostname, '-web.onrender.com', '-api.onrender.com');
    if (companionHost) {
      return `${window.location.protocol}//${companionHost}`;
    }

    return window.location.origin;
  }

  return '';
};
