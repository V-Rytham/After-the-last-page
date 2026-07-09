import { io } from 'socket.io-client';
import { getStoredToken, getStoredUser } from './auth';
import { getSocketServerUrl } from './serviceUrls';

/**
 * One shared connection for the whole app. Created at module scope so a remount
 * never opens a second socket; `autoConnect: false` leaves the decision of when
 * to dial to SocketContext, once a user is known.
 *
 * Transports are left at the Socket.IO default (polling, then upgrade to
 * websocket). The load balancer pins Engine.IO sessions to the backend that
 * issued them, so polling is safe; keeping it preserves the fallback for
 * networks that block websockets.
 */
export const meetSocket = io(getSocketServerUrl(), {
  withCredentials: true,
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 600,
  timeout: 4000,
});

const readDisplayName = (user) => String(
  user?.displayName || user?.username || user?.name || '',
).trim();

/**
 * Refreshes the credentials sent on the next handshake.
 * @returns {boolean} true when they differ from what the live connection used,
 *   meaning the caller must reconnect for them to take effect.
 */
export const syncMeetSocketAuth = (currentUser = getStoredUser()) => {
  const token = getStoredToken();
  const next = token ? { token, displayName: readDisplayName(currentUser) } : {};

  const changed = meetSocket.auth?.token !== next.token
    || meetSocket.auth?.displayName !== next.displayName;

  meetSocket.auth = next;
  return changed;
};
