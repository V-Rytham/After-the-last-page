import { io } from 'socket.io-client';
import { getStoredToken, getStoredUser } from './auth';
import { getSocketServerUrl } from './serviceUrls';

const socketServer = getSocketServerUrl();

export const meetSocket = io(socketServer, {
  withCredentials: true,
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 600,
  timeout: 4000,
});

export const syncMeetSocketAuth = (currentUser = getStoredUser()) => {
  const token = getStoredToken();
  const displayName = String(currentUser?.displayName || currentUser?.username || currentUser?.name || '').trim();
  meetSocket.auth = token ? { token, displayName } : {};
};

