import { Redis } from 'ioredis';

/**
 * Socket.IO's Redis adapter needs two dedicated connections: once a client
 * enters subscriber mode it can no longer issue ordinary commands. The
 * application's own reads/writes therefore need a third.
 */
export const createRedisClients = async (url) => {
  const options = { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: true };

  const data = new Redis(url, options);
  const pub = new Redis(url, options);
  const sub = pub.duplicate({ lazyConnect: true });

  await Promise.all([data.connect(), pub.connect(), sub.connect()]);

  return {
    data,
    pub,
    sub,
    close: async () => {
      await Promise.allSettled([data.quit(), pub.quit(), sub.quit()]);
    },
  };
};
