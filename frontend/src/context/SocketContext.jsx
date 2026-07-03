/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { meetSocket, syncMeetSocketAuth } from '../utils/socket';

const SocketContext = createContext(null);
const SOCKET_CONNECT_TIMEOUT_MS = 3500;

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
    syncMeetSocketAuth(currentUser);

    if (forceReconnect && meetSocket.connected) {
      meetSocket.disconnect();
    }

    if (meetSocket.connected) {
      return meetSocket;
    }

    setSocketConnecting(true);

    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        meetSocket.off('connect', onConnect);
        meetSocket.off('connect_error', onConnectError);
        reject(new Error('Socket connection timed out.'));
      }, SOCKET_CONNECT_TIMEOUT_MS);

      const onConnect = () => {
        window.clearTimeout(timeout);
        meetSocket.off('connect', onConnect);
        meetSocket.off('connect_error', onConnectError);
        resolve();
      };

      const onConnectError = (error) => {
        window.clearTimeout(timeout);
        meetSocket.off('connect', onConnect);
        meetSocket.off('connect_error', onConnectError);
        reject(error || new Error('Socket connection failed.'));
      };

      meetSocket.on('connect', onConnect);
      meetSocket.on('connect_error', onConnectError);
      meetSocket.connect();
    });

    return meetSocket;
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      if (meetSocket.connected) {
        meetSocket.disconnect();
      }
      return;
    }

    syncMeetSocketAuth(currentUser);
    if (!meetSocket.connected) {
      meetSocket.connect();
    }
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
