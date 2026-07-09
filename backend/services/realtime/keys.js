const PREFIX = 'alp:rt';

export const keys = {
  session: (userId) => `${PREFIX}:session:${userId}`,
  queue: (queueKey) => `${PREFIX}:queue:${queueKey}`,
  userQueue: (userId) => `${PREFIX}:userqueue:${userId}`,
  room: (roomId) => `${PREFIX}:room:${roomId}`,
  userRoom: (userId) => `${PREFIX}:userroom:${userId}`,
  roomSequence: `${PREFIX}:roomseq`,
  searching: `${PREFIX}:searching`,
};

/** Socket.IO room holding every live socket of one user, across all instances. */
export const userChannel = (userId) => `user:${userId}`;
