import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Video, MessageSquare, Mic, User, Send, Bot, LogOut } from 'lucide-react';
import { useSocketConnection } from '../context/SocketContext';
import api from '../utils/api';
import { getOrCreateIdentity } from '../utils/identity';
import { getApiBaseUrl } from '../utils/serviceUrls';
import { log } from '../utils/logger';
import bookfriendAvatar from '../assets/bookfriend-avatar.jpg';
import './MeetingHub.css';

const BOOK_READ_TIMEOUT_MS = 120000;

const MeetingHub = () => {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket, socketConnected, ensureConnected } = useSocketConnection();

  const initialPrefType = useMemo(() => {
    const candidate = String(location?.state?.prefType || 'text').trim().toLowerCase();
    if (candidate === 'voice' || candidate === 'video' || candidate === 'text') return candidate;
    return 'text';
  }, [location?.state?.prefType]);
  const isObjectId = React.useMemo(() => /^[a-f0-9]{24}$/i.test(String(bookId || '')), [bookId]);
  const meetRoomState = location?.state?.meetRoom || null;
  const parsedSourceRoute = React.useMemo(() => {
    if (!bookId) return null;
    const decoded = decodeURIComponent(String(bookId));
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    const source = decoded.slice(0, separator).trim().toLowerCase();
    const sourceId = decoded.slice(separator + 1).trim();
    if (!source || !sourceId) return null;
    return { source, sourceId, composite: decoded };
  }, [bookId]);
  const matchBookId = useMemo(
    () => String(meetRoomState?.canonical_book_id || bookId || '').trim(),
    [bookId, meetRoomState?.canonical_book_id],
  );

  const [phase, setPhase] = useState('preferences');
  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState(null);
  const [matchRole, setMatchRole] = useState(null);
  const [partnerDisplayName, setPartnerDisplayName] = useState('Reader');
  const [messages, setMessages] = useState([]);
  const [socketReady, setSocketReady] = useState(false);
  const [matchNotice, setMatchNotice] = useState('');
  const [searchHint, setSearchHint] = useState('');
  const [bookFriendSessionId, setBookFriendSessionId] = useState(null);
  const [bookFriendStarting, setBookFriendStarting] = useState(false);
  const [bookFriendThinking, setBookFriendThinking] = useState(false);
  const [searchSeconds, setSearchSeconds] = useState(0);
  const [searchingDots, setSearchingDots] = useState('.');
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [leavePromptBody, setLeavePromptBody] = useState('You will disconnect from this reader.');
  const pendingLeaveActionRef = useRef(null);
  const messageListRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const socketRef = useRef(socket);
  const searchIntervalRef = useRef(null);
  const cleanupInFlightRef = useRef(false);

  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const roomIdRef = useRef(null);
  const startCallRef = useRef(null);
  const [mediaStatus, setMediaStatus] = useState('idle');
  const [mediaError, setMediaError] = useState('');

  const [chatInput, setChatInput] = useState('');
  const [prefType, setPrefType] = useState(initialPrefType);
  const hasUnsentDraft = chatInput.trim().length > 0;

  const threadRouteId = useMemo(() => {
    const src = String(book?.source || parsedSourceRoute?.source || '').trim().toLowerCase();
    const srcId = String(book?.sourceId || book?.source_book_id || parsedSourceRoute?.sourceId || '').trim();
    if (!src || !srcId) return '';
    return `${src}:${srcId}`;
  }, [book?.source, book?.sourceId, book?.source_book_id, parsedSourceRoute?.source, parsedSourceRoute?.sourceId]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    const listEl = messageListRef.current;
    if (!listEl || !shouldAutoScrollRef.current) return;
    listEl.scrollTop = listEl.scrollHeight;
  }, [messages]);

  const handleMessageListScroll = useCallback(() => {
    const listEl = messageListRef.current;
    if (!listEl) return;
    const distanceFromBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 24;
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        if (meetRoomState?.title) {
          setBook({
            _id: matchBookId,
            id: matchBookId,
            title: meetRoomState.title,
            author: meetRoomState.author || 'Unknown author',
            source: meetRoomState.source,
            sourceId: meetRoomState.source_book_id,
          });
          return;
        }

        if (parsedSourceRoute) {
          const { data: readData } = await api.get('/books/read', {
            timeout: BOOK_READ_TIMEOUT_MS,
            params: {
              source: parsedSourceRoute.source,
              id: parsedSourceRoute.sourceId,
            },
          });
          const payload = readData?.data || readData;
          setBook({
            _id: matchBookId || parsedSourceRoute.composite,
            id: matchBookId || parsedSourceRoute.composite,
            title: payload?.title || 'Untitled',
            author: payload?.author || 'Unknown author',
            source: parsedSourceRoute.source,
            sourceId: parsedSourceRoute.sourceId,
          });
          return;
        }

        if (isObjectId) {
          const { data } = await api.get(`/books/${bookId}`);
          setBook(data);
          return;
        }

        setBook({ _id: matchBookId, id: matchBookId, title: 'Private chat', author: 'Verified book', source: '', sourceId: '' });
      } catch (error) {
        console.error('Fetch error:', error);
        setBook(null);
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    const activeSocket = socketRef.current;
    if (!activeSocket) {
      return () => {};
    }

    const onConnect = () => {
      setSocketReady(true);
      setMatchNotice('');
    };

    const onConnectError = (error) => {
      console.error('Socket connection failed:', error);
      setSocketReady(false);
      setMatchNotice('Live matching is offline right now. You can still open the book threads.');
    };

    const onMatchFound = ({ roomId: matchedRoomId, role, partnerUsername, partnerName }) => {
      setRoomId(matchedRoomId);
      setMatchRole(role || null);
      const normalizedPartner = String(partnerUsername || partnerName || '').trim();
      setPartnerDisplayName(normalizedPartner || 'Reader');
      setPhase('connected');
      activeSocket.emit('enter_conversation', { roomId: matchedRoomId });
      window.dispatchEvent(new Event('atlp-session-hint'));
    };

    const onAccessDenied = ({ message }) => {
      setMatchNotice(String(message || 'Live chats are only available for open-access books.'));
    };

    const onReceiveMessage = ({ message }) => {
      setMessages((prev) => [...prev, { text: message, sender: 'partner', timestamp: new Date() }]);
    };

    const onPartnerLeft = ({ message } = {}) => {
      if (peerRef.current) {
        try { peerRef.current.close(); } catch { /* ignore */ }
        peerRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((track) => track.stop());
        remoteStreamRef.current = null;
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      pendingOfferRef.current = null;
      setMediaStatus('idle');
      setMediaError('');
      setMatchNotice(String(message || 'The other reader has left the chat.'));
      setRoomId(null);
      setPartnerDisplayName('Reader');
      setMessages([]);
      setPhase('preferences');
      window.dispatchEvent(new Event('atlp-session-hint'));
    };

    const onWebRtcOffer = async ({ offer }) => {
      if (!offer) return;
      try {
        if (!localStreamRef.current) {
          pendingOfferRef.current = offer;
          if (typeof startCallRef.current === 'function') startCallRef.current();
          return;
        }
        const pc = peerRef.current;
        if (!pc) {
          pendingOfferRef.current = offer;
          return;
        }
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        activeSocket.emit('webrtc_answer', { roomId: roomIdRef.current, answer: pc.localDescription });
        setMediaStatus('connecting');
      } catch (error) {
        setMediaError(error?.message || 'Failed handling WebRTC offer.');
        setMediaStatus('failed');
      }
    };

    const onWebRtcAnswer = async ({ answer }) => {
      if (!answer) return;
      try {
        const pc = peerRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(answer);
        setMediaStatus('connecting');
      } catch (error) {
        setMediaError(error?.message || 'Failed handling WebRTC answer.');
        setMediaStatus('failed');
      }
    };

    const onWebRtcCandidate = async ({ candidate }) => {
      if (!candidate) return;
      try {
        const pc = peerRef.current;
        if (!pc) return;
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore
      }
    };

    activeSocket.off('connect', onConnect);
    activeSocket.off('connect_error', onConnectError);
    activeSocket.off('match_found', onMatchFound);
    activeSocket.off('access_denied', onAccessDenied);
    activeSocket.off('receive_message', onReceiveMessage);
    activeSocket.off('partner_left', onPartnerLeft);
    activeSocket.off('webrtc_offer', onWebRtcOffer);
    activeSocket.off('webrtc_answer', onWebRtcAnswer);
    activeSocket.off('webrtc_ice_candidate', onWebRtcCandidate);

    activeSocket.on('connect', onConnect);
    activeSocket.on('connect_error', onConnectError);
    activeSocket.on('match_found', onMatchFound);
    activeSocket.on('access_denied', onAccessDenied);
    activeSocket.on('receive_message', onReceiveMessage);
    activeSocket.on('partner_left', onPartnerLeft);
    activeSocket.on('webrtc_offer', onWebRtcOffer);
    activeSocket.on('webrtc_answer', onWebRtcAnswer);
    activeSocket.on('webrtc_ice_candidate', onWebRtcCandidate);

    setSocketReady(activeSocket.connected);

    return () => {
      activeSocket.off('connect', onConnect);
      activeSocket.off('connect_error', onConnectError);
      activeSocket.off('match_found', onMatchFound);
      activeSocket.off('access_denied', onAccessDenied);
      activeSocket.off('receive_message', onReceiveMessage);
      activeSocket.off('partner_left', onPartnerLeft);
      activeSocket.off('webrtc_offer', onWebRtcOffer);
      activeSocket.off('webrtc_answer', onWebRtcAnswer);
      activeSocket.off('webrtc_ice_candidate', onWebRtcCandidate);
    };
  }, [bookId, matchBookId, meetRoomState, navigate, parsedSourceRoute, isObjectId, socket]);

  useEffect(() => {
    setSocketReady(socketConnected);
  }, [socketConnected]);

  const sessionIsSensitive = phase === 'searching' || phase === 'connected' || phase === 'bookfriend';

  const closeBookFriendSession = useCallback(() => {
    if (!bookFriendSessionId) return;
    api.post('/agent/end', { session_id: bookFriendSessionId }).catch(() => {});
    setBookFriendSessionId(null);
  }, [bookFriendSessionId]);

  useEffect(() => () => {
    if (bookFriendSessionId) api.post('/agent/end', { session_id: bookFriendSessionId }).catch(() => {});
  }, [bookFriendSessionId]);

  const endSession = useCallback(async (reason = 'leave') => {
    if (cleanupInFlightRef.current) {
      return;
    }

    cleanupInFlightRef.current = true;

    try {
      if (phase === 'searching') {
        const identity = getOrCreateIdentity();
        await api.post('/matchmaking/leave', {
          userId: identity?.userId,
          displayName: identity?.displayName,
        }).catch(() => {});
      }

      if (phase === 'connected' && roomId) {
        socketRef.current?.emit('leave_room', { roomId, reason });
      }

      if (phase === 'bookfriend') {
        closeBookFriendSession();
      }

      await api.post('/session/end', { reason }).catch(() => {});
    } finally {
      cleanupInFlightRef.current = false;
    }
  }, [closeBookFriendSession, phase, roomId]);

  useEffect(() => {
    if (!socketReady) {
      return;
    }
    api.get('/session/status')
      .then(({ data }) => {
        const state = data?.session?.state;
        if (state === 'SEARCHING' || state === 'MATCHED' || state === 'IN_CONVERSATION') {
          return api.post('/session/end', { reason: 'restore-reset' });
        }
        return null;
      })
      .catch(() => {})
      .finally(() => {
        api.post('/session/start', { state: 'IDLE', bookId }).catch(() => {});
      });
  }, [bookId, socketReady]);

  useEffect(() => {
    if (!sessionIsSensitive) {
      return undefined;
    }

    const handleBeforeUnload = (event) => {
      try {
        const identity = getOrCreateIdentity();
        if (identity?.userId && navigator.sendBeacon) {
          const payload = JSON.stringify({ ...identity, reason: 'beforeunload' });
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon(`${getApiBaseUrl()}/session/end`, blob);
        }
      } catch {
        // ignore
      }

      event.preventDefault();
      event.returnValue = 'Leaving will end your current session.';
      return event.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessionIsSensitive]);

  useEffect(() => {
    const handleBeforeUnloadDraft = (event) => {
      if (!hasUnsentDraft) return;
      event.preventDefault();
      event.returnValue = 'You have an unsent message.';
      return event.returnValue;
    };
    window.addEventListener('beforeunload', handleBeforeUnloadDraft);
    return () => window.removeEventListener('beforeunload', handleBeforeUnloadDraft);
  }, [hasUnsentDraft]);

  useEffect(() => () => {
    if (sessionIsSensitive) {
      endSession('route-unmount');
    }
  }, [endSession, sessionIsSensitive]);

  const cleanupMedia = useCallback(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    if (peerRef.current) {
      try { peerRef.current.close(); } catch { /* ignore */ }
      peerRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
    }
    pendingOfferRef.current = null;
    setMediaStatus('idle');
    setMediaError('');
  }, []);

  const returnToPreferences = useCallback(async (reason = 'back') => {
    await endSession(reason);
    cleanupMedia();
    setRoomId(null);
    setMessages([]);
    setChatInput('');
    setPhase('preferences');
  }, [cleanupMedia, endSession]);

  useEffect(() => () => {
    cleanupMedia();
  }, [cleanupMedia]);

  const startCall = useCallback(async () => {
    if (prefType === 'text') return;
    try {
      setMediaStatus('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: prefType === 'video' });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      peerRef.current = pc;
      remoteStreamRef.current = new MediaStream();
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStreamRef.current;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (event) => event.streams[0].getTracks().forEach((track) => remoteStreamRef.current?.addTrack(track));
      pc.onicecandidate = (event) => {
        if (event.candidate) socketRef.current?.emit('webrtc_ice_candidate', { roomId: roomIdRef.current, candidate: event.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setMediaStatus('connected');
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
          cleanupMedia();
          setMediaStatus('failed');
        }
      };

      if (pendingOfferRef.current) {
        await pc.setRemoteDescription(pendingOfferRef.current);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit('webrtc_answer', { roomId: roomIdRef.current, answer: pc.localDescription });
        pendingOfferRef.current = null;
        setMediaStatus('connecting');
        return;
      }

      if (matchRole === 'initiator') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('webrtc_offer', { roomId: roomIdRef.current, offer: pc.localDescription });
      }
      setMediaStatus('ready');
    } catch (error) {
      setMediaError(error?.message || 'Unable to access camera or microphone.');
      setMediaStatus('failed');
    }
  }, [cleanupMedia, matchRole, prefType]);

  startCallRef.current = startCall;

  useEffect(() => {
    if (phase !== 'connected') cleanupMedia();
  }, [cleanupMedia, phase]);

  useEffect(() => () => {
    cleanupMedia();
  }, [cleanupMedia]);

  useEffect(() => {
    if (phase !== 'searching') return undefined;
    setSearchSeconds(0);
    setSearchingDots('.');

    if (searchIntervalRef.current) {
      window.clearInterval(searchIntervalRef.current);
    }

    searchIntervalRef.current = window.setInterval(() => {
      setSearchSeconds((prev) => prev + 1);
    }, 1000);

    setSearchHint('Looking for someone who just finished this book.');
    const nudgeTimeoutId = window.setTimeout(() => setSearchHint('Scanning for someone in the same chapter-afterglow.'), 12000);
    const delayTimeoutId = window.setTimeout(() => setSearchHint('This is taking longer than usual. Hang tight.'), 32000);
    return () => {
      window.clearTimeout(nudgeTimeoutId);
      window.clearTimeout(delayTimeoutId);
      if (searchIntervalRef.current) {
        window.clearInterval(searchIntervalRef.current);
        searchIntervalRef.current = null;
      }
    };
  }, [phase, prefType]);

  useEffect(() => {
    if (phase !== 'searching') return undefined;
    const dotsInterval = window.setInterval(() => {
      setSearchingDots((prev) => (prev === '.' ? '..' : prev === '..' ? '...' : '.'));
    }, 420);
    return () => window.clearInterval(dotsInterval);
  }, [phase]);

  if (loading) return <div className="p-10 text-center mt-20 font-serif">Deep in the archives... Seeking your book.</div>;
  if (!book) return <div className="p-10 text-center mt-20 font-serif">Book not found. Perhaps it's still being written?</div>;

  const handleStartSearch = async () => {
    if (bookFriendStarting) return;
    if (!socketRef.current?.connected) {
      setMatchNotice('Connecting to live matching…');
      try {
        await ensureConnected();
      } catch {
      setMatchNotice('Live matching is unavailable right now. Please try again shortly, or open the book threads.');
        return;
      }
    }
    setPhase('searching');
    setMatchNotice('');
    const identity = getOrCreateIdentity();
    const attemptJoin = async () => api.post('/meet/join', {
      source: book?.source,
      source_book_id: book?.sourceId,
      prefType,
      userId: identity?.userId,
      displayName: identity?.displayName,
    });

    await attemptJoin().then(() => {
      window.dispatchEvent(new Event('atlp-session-hint'));
    }).catch(async (error) => {
      const statusCode = Number(error?.response?.status || 0);
      const serverMessage = String(error?.response?.data?.message || error?.response?.data?.error || '').trim();
      const socketMismatch = statusCode === 409 && /no active socket connection/i.test(serverMessage);

      if (socketMismatch) {
        try {
          await ensureConnected({ forceReconnect: true });
          await attemptJoin();
          window.dispatchEvent(new Event('atlp-session-hint'));
          return;
        } catch {
          // Fall through to the generic message below.
        }
      }

      console.error('Failed to join matchmaking:', error);
      setMatchNotice(serverMessage || 'Unable to start matchmaking right now. Please try again.');
      setPhase('preferences');
    });
  };

  const handleStartBookFriend = async () => {
    if (!book || bookFriendStarting) return;

    setBookFriendStarting(true);
    setMatchNotice('Connecting to BookFriendâ€¦');

    try {
      const agentBookId = isObjectId
        ? String(bookId)
        : (book?.source && book?.sourceId ? `${book.source}:${book.sourceId}` : String(matchBookId));

      const { data } = await api.post('/agent/start', {
        book_id: agentBookId,
        book_title: book?.title,
        book_author: book?.author,
      });

      const sessionId = String(data?.session_id || '').trim();
      if (!sessionId) {
        throw new Error('BookFriend session unavailable.');
      }

      setBookFriendSessionId(sessionId);
      setMessages([
        {
          text: `Hi — I’m BookFriend. Want to talk about “${book.title}”?`,
          sender: 'bookfriend',
          timestamp: new Date(),
        },
      ]);
      setChatInput('');
      setBookFriendThinking(false);
      setPhase('bookfriend');
    } catch (error) {
      const statusCode = Number(error?.response?.status || 0);
      const serverMessage = String(error?.response?.data?.message || error?.response?.data?.error || '').trim();

      if (statusCode === 401) {
        setMatchNotice('Please sign in to use BookFriend.');
      } else if (statusCode === 503) {
        setMatchNotice(serverMessage || 'BookFriend is offline right now. Please try again shortly.');
      } else {
        setMatchNotice(serverMessage || 'Could not start BookFriend right now. Please try again.');
      }
    } finally {
      setBookFriendStarting(false);
    }
  };

  const sendBookFriendMessage = async (event) => {
    event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || !bookFriendSessionId) return;
    setMessages((prev) => [...prev, { text: trimmed, sender: 'me', timestamp: new Date() }]);
    setChatInput('');
    setBookFriendThinking(true);
    try {
      const payload = { session_id: bookFriendSessionId, message: trimmed };
      log('Payload:', payload);
      const { data } = await api.post('/agent/message', payload);
      setMessages((prev) => [...prev, { text: data.response, sender: 'bookfriend', timestamp: new Date() }]);
    } catch {
      setMessages((prev) => [...prev, { text: 'Sorry, I lost the thread for a moment. Could you try that again?', sender: 'bookfriend', timestamp: new Date() }]);
    } finally {
      setBookFriendThinking(false);
    }
  };

  const sendMessage = (event) => {
    if (event) event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || !roomId || !socketRef.current) return;
    const msgData = { roomId, message: trimmed, senderId: socketRef.current.id };
    socketRef.current.emit('send_message', msgData);
    setMessages((prev) => [...prev, { text: trimmed, sender: 'me', timestamp: new Date() }]);
    setChatInput('');
  };

  const handleChatKeyDown = (event, submit) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const mediaConnected = mediaStatus === 'ready' || mediaStatus === 'connecting' || mediaStatus === 'connected';

  const getMessageTimeLabel = (timestamp) => {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const renderMessageList = () => (
    <div
      ref={messageListRef}
      className="chat-messages"
      aria-label="Chat messages"
      onScroll={handleMessageListScroll}
    >
      {messages.length === 0 && (
        <div className="chat-empty-state" role="status" aria-live="polite">
          <MessageSquare size={20} />
          <p>You’re now connected. Start the conversation.</p>
        </div>
      )}
      {messages.map((m, i) => {
        const previous = messages[i - 1];
        const next = messages[i + 1];
        const isMine = m.sender === 'me';
        const isBookFriend = m.sender === 'bookfriend';
        const isFirstInGroup = !previous || previous.sender !== m.sender;
        const isLastInGroup = !next || next.sender !== m.sender;
        return (
          <div
            key={m?.id || `${m?.sender || 'user'}-${m?.timestamp || i}-${i}`}
            className={`message ${isMine ? 'sent' : 'received'} ${isFirstInGroup ? 'group-start' : 'group-mid'} ${isLastInGroup ? 'group-end' : ''}`}
          >
            {!isMine && isFirstInGroup && (
              <div className={`message-avatar${isBookFriend ? ' message-avatar--bookfriend' : ''}`} aria-hidden="true">
                {isBookFriend ? <img src={bookfriendAvatar} alt="" /> : <User size={14} />}
              </div>
            )}
            <div className="message-content">
              <div className="msg-bubble">{m.text}</div>
              {isLastInGroup && <span className="msg-time">{getMessageTimeLabel(m.timestamp)}</span>}
            </div>
          </div>
        );
      })}
      {bookFriendThinking && (
        <div className="message received group-start message--thinking" role="status" aria-live="polite">
          <div className="message-avatar message-avatar--bookfriend" aria-hidden="true"><img src={bookfriendAvatar} alt="" /></div>
          <div className="message-content">
            <div className="msg-bubble msg-bubble--thinking">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-label">BookFriend is reflecting</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={`meeting-hub meeting-hub--${phase} animate-fade-in`}>
      {phase === 'preferences' && (
        <div className="preferences-container animate-fade-in">
          <div className="preferences-content glass-panel">
            <button
              type="button"
              className="meeting-back-btn"
              onClick={() => {
                try {
                  navigate(-1);
                } catch {
                  navigate('/meet');
                }
              }}
            >
              <span aria-hidden="true">←</span>
              <span>Back</span>
            </button>

            <div className="meeting-pref-header">
              <h2 className="font-serif">How would you like to connect?</h2>
              <p>Select your preferred medium to chat about <em>{book.title}</em>. Your identity remains anonymous.</p>
            </div>

            <div className="pref-options" aria-label="Connection method options">
              <button type="button" disabled={bookFriendStarting} className={`pref-card ${prefType === 'text' ? 'selected' : ''}`} onClick={() => { setPrefType('text'); setMatchNotice(''); }}>
                <span className="pref-icon-shell"><MessageSquare className="pref-icon" size={22} strokeWidth={2.1} /></span>
                <span className="pref-card-copy"><strong>Text Chat</strong><span>Quiet, thoughtful chat.</span></span>
              </button>
              <button type="button" disabled={bookFriendStarting} className={`pref-card ${prefType === 'voice' ? 'selected' : ''}`} onClick={() => { setPrefType('voice'); setMatchNotice(''); }}>
                <span className="pref-icon-shell"><Mic className="pref-icon" size={22} strokeWidth={2.1} /></span>
                <span className="pref-card-copy"><strong>Voice Call</strong><span>Vocalize your thoughts securely.</span></span>
              </button>
              <button type="button" disabled={bookFriendStarting} className={`pref-card ${prefType === 'video' ? 'selected' : ''}`} onClick={() => { setPrefType('video'); setMatchNotice(''); }}>
                <span className="pref-icon-shell"><Video className="pref-icon" size={22} strokeWidth={2.1} /></span>
                <span className="pref-card-copy"><strong>Video Call</strong><span>Face-to-face, masked connection.</span></span>
              </button>
            </div>
            {matchNotice && <div className="meeting-notice" role="status">{matchNotice}</div>}
            <div className="meeting-pref-actions">
              <button className="btn-primary meeting-primary-action" disabled={!prefType || !socketReady || bookFriendStarting} onClick={handleStartSearch}>
                Find a reading partner <ArrowRight size={18} />
              </button>
              <button className="btn-secondary meeting-secondary-action" onClick={handleStartBookFriend} disabled={bookFriendStarting}>
                {bookFriendStarting ? 'Connecting BookFriend…' : (<><User size={16} /> Chat with BookFriend</>)}
              </button>
              {threadRouteId ? (
                <button className="meeting-tertiary-action" disabled={bookFriendStarting} onClick={() => navigate(`/thread/${encodeURIComponent(threadRouteId)}`, { state: { book } })}>Open the book threads instead</button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {phase === 'searching' && (
        <div className="searching-container animate-fade-in">
          <div className="searching-card glass-panel">
            <div className="searching-header">
              <h2 className="font-serif searching-title">
                Finding a reader<span className="searching-dots" aria-hidden="true">{searchingDots}</span>
              </h2>
              <p className="text-muted searching-subtitle">
                {searchHint}
              </p>
            </div>

            <div className="searching-progress" role="status" aria-live="polite">
              <span>Searching... ({Math.max(0, searchSeconds)}s)</span>
              <div className="searching-progress-line" aria-hidden="true">
                <span className="searching-progress-line-fill" />
              </div>
            </div>

            <div className="searching-actions">
              <button type="button" className="btn-secondary sm" onClick={() => returnToPreferences('search-cancel')}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'bookfriend' && (
        <div className="room-container animate-fade-in">
          <section className="room-main glass-panel">
            <header className="room-header room-header--sticky room-header--bookfriend">
              <div className="partner-info">
                <div className="wizard-avatar" aria-hidden="true"><img src={bookfriendAvatar} alt="" /></div>
                <div className="partner-copy">
                  <div className="room-title font-serif">BookFriend</div>
                  <div className="room-subtitle text-muted">Connected · AI companion</div>
                </div>
              </div>

              <div className="room-actions">
                <button
                  type="button"
                  className="btn-secondary sm btn-leave-inline"
                  onClick={() => {
                    returnToPreferences('leave-bookfriend');
                  }}
                >
                  Leave
                </button>
              </div>
            </header>
            <div className="chat-interface">
              {renderMessageList()}
              <form className="chat-input-area" onSubmit={sendBookFriendMessage}>
                <textarea
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(event) => handleChatKeyDown(event, () => sendBookFriendMessage(event))}
                  placeholder="Share your thought..."
                  disabled={!bookFriendSessionId || bookFriendThinking}
                  rows={1}
                />
                <button type="submit" className="send-btn" aria-label="Send" disabled={!bookFriendSessionId || !chatInput.trim() || bookFriendThinking}>
                  <Send size={16} />
                </button>
              </form>
            </div>
          </section>
        </div>
      )}

      {phase === 'connected' && (
        <div className="room-container animate-fade-in">
          <section className="room-main glass-panel">
            <header className="room-header room-header--sticky">
              <div className="partner-info">
                <div className="partner-avatar" aria-hidden="true">
                  <User size={18} />
                </div>
                <div className="partner-copy">
                  <div className="room-title font-serif">{partnerDisplayName || 'Reader'}</div>
                  <div className="room-subtitle text-muted">Online now</div>
                </div>
              </div>

              <div className="room-actions">
                <button
                  type="button"
                  className="btn-leave sm"
                  onClick={() => {
                    setLeavePromptBody('You will disconnect from this reader.');
                    pendingLeaveActionRef.current = () => {
                      returnToPreferences('leave-reader');
                    };
                    setLeavePromptOpen(true);
                  }}
                >
                  <LogOut size={15} aria-hidden="true" />
                  Leave
                </button>
              </div>
            </header>
            {prefType !== 'text' && (
              <div className="media-stage" aria-label="Call area">
                {prefType === 'video' && (
                  <div className="video-grid">
                    <video ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
                    <video ref={localVideoRef} autoPlay muted playsInline className="local-video" />
                  </div>
                )}
                {prefType === 'voice' && <audio ref={remoteAudioRef} autoPlay />}

                {!mediaConnected && (
                  <div className="media-actions">
                    <button className="btn-primary sm" onClick={startCall} type="button">
                      Start call
                    </button>
                  </div>
                )}
                {mediaError && <p className="text-error text-xs media-error">{mediaError}</p>}
              </div>
            )}

            <div className="chat-interface">
              {renderMessageList()}
              <form className="chat-input-area" onSubmit={sendMessage}>
                <textarea
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(event) => handleChatKeyDown(event, sendMessage)}
                  placeholder="Send a message..."
                  rows={1}
                />
                <button type="submit" className="send-btn" aria-label="Send" disabled={!chatInput.trim()}>
                  <Send size={16} />
                </button>
              </form>
            </div>
          </section>
        </div>
      )}

      {leavePromptOpen && (
        <div className="leave-guard-overlay" role="dialog" aria-modal="true" aria-label="Leave session confirmation">
          <div className="leave-guard-card glass-panel">
            <h2 className="font-serif">Leave chat?</h2>
            <p>{leavePromptBody}</p>
            <div className="leave-guard-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setLeavePromptOpen(false);
                  pendingLeaveActionRef.current = null;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const proceed = pendingLeaveActionRef.current;
                  setLeavePromptOpen(false);
                  pendingLeaveActionRef.current = null;
                  endSession('guard-leave').finally(() => {
                    proceed?.();
                  });
                }}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MeetingHub;
