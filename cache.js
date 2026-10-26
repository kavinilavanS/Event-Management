const Redis = require('ioredis');

class CacheManager {
  constructor() {
    this.memoryStore = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      type: 'in-memory'
    };
    this.redisClient = null;

    if (process.env.REDIS_URL) {
      try {
        this.redisClient = new Redis(process.env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null // don't hang if redis unavailable
        });
        this.redisClient.connect()
          .then(() => {
            console.log('[Cache] Connected to Redis instance:', process.env.REDIS_URL);
            this.stats.type = 'redis';
          })
          .catch(err => {
            console.log('[Cache] Redis connection failed, falling back to in-memory cache:', err.message);
            this.redisClient = null;
          });
      } catch (err) {
        console.log('[Cache] Failed initializing Redis client, using in-memory store:', err.message);
      }
    } else {
      console.log('[Cache] No REDIS_URL provided. Running with high-speed in-memory TTL caching.');
    }
  }

  async get(key) {
    if (this.redisClient) {
      try {
        const val = await this.redisClient.get(key);
        if (val) {
          this.stats.hits++;
          return JSON.parse(val);
        }
        this.stats.misses++;
        return null;
      } catch (e) {
        // Fallback to memory on redis error
      }
    }

    const item = this.memoryStore.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() > item.expiresAt) {
      this.memoryStore.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.data;
  }

  async set(key, value, ttlSeconds = 60) {
    this.stats.sets++;
    if (this.redisClient) {
      try {
        await this.redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        return;
      } catch (e) {
        // Fallback
      }
    }

    this.memoryStore.set(key, {
      data: value,
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }

  async del(key) {
    this.stats.invalidations++;
    if (this.redisClient) {
      try {
        await this.redisClient.del(key);
      } catch (e) {}
    }
    this.memoryStore.delete(key);
  }

  async invalidatePattern(prefix) {
    this.stats.invalidations++;
    if (this.redisClient) {
      try {
        const keys = await this.redisClient.keys(prefix + '*');
        if (keys.length > 0) {
          await this.redisClient.del(...keys);
        }
      } catch (e) {}
    }

    for (const key of this.memoryStore.keys()) {
      if (key.startsWith(prefix)) {
        this.memoryStore.delete(key);
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      inMemoryKeyCount: this.memoryStore.size,
      uptimeSeconds: Math.floor(process.uptime())
    };
  }
}

const cache = new CacheManager();
module.exports = cache;
