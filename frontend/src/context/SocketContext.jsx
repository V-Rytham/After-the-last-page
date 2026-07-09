/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { meetSocket, syncMeetSocketAuth } from '../utils/socket';

const SocketContext = createContext(null);
const SOCKET_CONNECT_TIMEOUT_MS = 3500;

/**
 * Resolves once the shared socket is connected, or rejects on error/timeout.
 * Listeners are always removed on every exit path, so repeated calls cannot
 * accumulate handlers on the singleton.
 */
const waitForConnect = (timeoutMs) => new Promise((resolve, reject) => {
  const settle = (finish) => (value) => {
    window.clearTimeout(timer);
    meetSocket.off('connect', onConnect);
    meetSocket.off('connect_error', onConnectError);
    finish(value);
  };

  const onConnect = settle(resolve);
  const onConnectError = settle((error) => reject(error || new Error('Socket connection failed.')));
  const onTimeout = settle(() => reject(new Error('Socket connection timed out.')));
  const timer = window.setTimeout(onTimeout, timeoutMs);

  meetSocket.on('connect', onConnect);
  meetSocket.on('connect_error', onConnectError);
  meetSocket.connect();
});

export const SocketProvider = ({ currentUser, children }) => {
  const [socketConnected, setSocketConnected] = useState(Boolean(meetSocket.connected));
  const [socketConnecting, setSocketConnecting] = useState(false);
  const [socketError, setSocketError] = useState('');

  useEffect(() => {
    const onConnect = () => {
      setSocketConnected(true);
      setSocketConnecting(false);
      setSocketError('');
    };

    const onDisconnect = () => {
      setSocketConnected(false);
      setSocketConnecting(false);
    };

    const onConnectError = (error) => {
      setSocketConnected(false);
      setSocketConnecting(false);
      setSocketError(String(error?.message || 'Unable to connect to live services.'));
    };

    meetSocket.on('connect', onConnect);
    meetSocket.on('disconnect', onDisconnect);
    meetSocket.on('connect_error', onConnectError);

    return () => {
      meetSocket.off('connect', onConnect);
      meetSocket.off('disconnect', onDisconnect);
      meetSocket.off('connect_error', onConnectError);
    };
  }, []);

  const ensureConnected = useCallback(async ({ forceReconnect = false } = {}) => {
    // The handshake sends `auth` once, at connect time. A token that changed
    // while we were connected only takes effect after a reconnect.
    const credentialsChanged = syncMeetSocketAuth(currentUser);

    if ((forceReconnect || credentialsChanged) && meetSocket.connected) {
      meetSocket.disconnect();
    }

    if (meetSocket.connected) return meetSocket;

    setSocketConnecting(true);
    try {
      await waitForConnect(SOCKET_CONNECT_TIMEOUT_MS);
    } finally {
      setSocketConnecting(false);
    }
    return meetSocket;
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      if (meetSocket.connected) meetSocket.disconnect();
      return;
    }

    const credentialsChanged = syncMeetSocketAuth(currentUser);
    if (credentialsChanged && meetSocket.connected) meetSocket.disconnect();
    if (!meetSocket.connected) meetSocket.connect();
  }, [currentUser]);

  const value = useMemo(() => ({
    socket: meetSocket,
    socketConnected,
    socketConnecting,
    socketError,
    ensureConnected,
  }), [ensureConnected, socketConnected, socketConnecting, socketError]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocketConnection = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocketConnection must be used within SocketProvider.');
  }
  return context;
};
