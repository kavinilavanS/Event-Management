const { db } = require('./db');
const cache = require('./cache');

class BackgroundHoldWorker {
  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.metrics = {
      totalRuns: 0,
      totalHoldsReleased: 0,
      lastRunTime: null,
      lastReleasedCount: 0,
      isRunning: false
    };
  }

  start() {
    if (this.timer) return;
    this.metrics.isRunning = true;
    console.log(`[Worker] Background hold cleanup worker started (polling every ${this.intervalMs / 1000}s)`);
    
    this.timer = setInterval(() => {
      this.sweep();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.metrics.isRunning = false;
      console.log('[Worker] Background hold cleanup worker stopped.');
    }
  }

  sweep() {
    this.metrics.totalRuns++;
    this.metrics.lastRunTime = new Date().toISOString();

    try {
      db.exec('BEGIN IMMEDIATE');

      // Find all expired holds that are still in HOLD status
      const expiredHolds = db.prepare(`
        SELECT h.id, h.tier_id, h.quantity, t.event_id 
        FROM reservation_holds h
        JOIN ticket_tiers t ON h.tier_id = t.id
        WHERE h.status = 'HOLD' AND datetime(h.expires_at) <= datetime('now')
      `).all();

      if (expiredHolds.length > 0) {
        const updateHold = db.prepare("UPDATE reservation_holds SET status = 'EXPIRED' WHERE id = ?");
        const restoreTier = db.prepare(`
          UPDATE ticket_tiers 
          SET available_capacity = available_capacity + ?,
              reserved_capacity = MAX(0, reserved_capacity - ?)
          WHERE id = ?
        `);

        const affectedEvents = new Set();

        for (const hold of expiredHolds) {
          updateHold.run(hold.id);
          restoreTier.run(hold.quantity, hold.quantity, hold.tier_id);
          affectedEvents.add(hold.event_id);
        }

        db.exec('COMMIT');

        // Invalidate cache for affected events
        for (const eventId of affectedEvents) {
          cache.del(`event:${eventId}`);
        }
        cache.del('events:list');

        this.metrics.totalHoldsReleased += expiredHolds.length;
        this.metrics.lastReleasedCount = expiredHolds.length;

        console.log(`[Worker] Cleaned up and released ${expiredHolds.length} expired reservation hold(s).`);
      } else {
        db.exec('COMMIT');
        this.metrics.lastReleasedCount = 0;
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rbErr) {}
      console.error('[Worker] Error during expired hold cleanup sweep:', err.message);
    }

    return this.metrics.lastReleasedCount;
  }

  getMetrics() {
    return {
      ...this.metrics
    };
  }
}

const worker = new BackgroundHoldWorker(5000);
module.exports = worker;
