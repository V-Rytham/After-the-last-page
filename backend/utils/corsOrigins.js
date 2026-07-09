const normalizeOriginList = (env = process.env) => (
  [
    env.CLIENT_URL,
    env.CLIENT_URL_FALLBACK,
    env.DEV_CLIENT_URL,
  ].filter(Boolean)
);

export const buildAllowedOrigins = (env = process.env) => new Set(normalizeOriginList(env));

export const isOriginAllowed = (origin, env = process.env) => {
  if (!origin) {
    return true;
  }

  const allowList = buildAllowedOrigins(env);
  if (allowList.has(origin) || origin.endsWith('.onrender.com')) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
    const isLocalPort = ['5173', '5174', '3000', '3001', '8080'].includes(parsed.port || '');

    return isLocalhost && (parsed.port === '' || isLocalPort);
  } catch {
    return false;
  }
};
