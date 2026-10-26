const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const cache = require('./cache');
const worker = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Vercel frontend cross-origin requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-role', 'x-tenant-id']
}));
app.use(express.json());

// Serve static frontend assets (checking ../frontend, public, and ../public)
const frontendDir = [
  path.join(__dirname, '../frontend'),
  path.join(__dirname, 'public'),
  path.join(__dirname, '../public')
].find(p => fs.existsSync(p)) || path.join(__dirname, '../frontend');

app.use(express.static(frontendDir));

// -------------------------------------------------------------
// Authentication & RBAC Middleware
// -------------------------------------------------------------
function authenticate(req, res, next) {
  const userId = req.headers['x-user-id'] || req.query.user_id || 'usr_att_1';
  const role = req.headers['x-role'] || req.query.role || 'ATTENDEE';
  const tenantId = req.headers['x-tenant-id'] || req.query.tenant_id || 'tenant_acme';

  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    try {
      db.prepare('INSERT OR IGNORE INTO users (id, tenant_id, name, email, role) VALUES (?, ?, ?, ?, ?)')
        .run(userId, tenantId, 'User ' + userId, `${userId}@example.com`, role);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    } catch (e) {}
  }

  req.user = user || {
    id: userId,
    name: 'User ' + userId,
    email: `${userId}@example.com`,
    role: role,
    tenant_id: tenantId
  };
  next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Role '${req.user.role}' is not authorized. Required: [${allowedRoles.join(', ')}]`
      });
    }
    next();
  };
}

// Health Check Endpoint (for Render and Vercel status checks)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'eventnest-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: 'sqlite_wal'
  });
});

app.use(authenticate);

// -------------------------------------------------------------
// 1. User & Identity Endpoints
// -------------------------------------------------------------
app.get('/api/auth/users', (req, res) => {
  const users = db.prepare('SELECT id, tenant_id, name, email, role, created_at FROM users').all();
  res.json({ users, currentUser: req.user });
});

// -------------------------------------------------------------
// 2. Event Management Endpoints (Organizer & Admin)
// -------------------------------------------------------------

// List active events (Attendee, Organizer, Admin) - Cached
app.get('/api/events', async (req, res) => {
  const cacheKey = req.user.role === 'ORGANIZER' 
    ? `events:tenant:${req.user.tenant_id}`
    : 'events:all';

  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json({ events: cached, source: 'cache' });
  }

  let query = `
    SELECT e.*, u.name as organizer_name,
      (SELECT COUNT(*) FROM ticket_tiers WHERE event_id = e.id) as tier_count,
      (SELECT SUM(total_capacity) FROM ticket_tiers WHERE event_id = e.id) as total_capacity,
      (SELECT SUM(available_capacity) FROM ticket_tiers WHERE event_id = e.id) as available_capacity,
      (SELECT SUM(reserved_capacity) FROM ticket_tiers WHERE event_id = e.id) as reserved_capacity
    FROM events e
    JOIN users u ON e.organizer_id = u.id
  `;
  const params = [];

  if (req.user.role === 'ORGANIZER') {
    query += ' WHERE e.tenant_id = ?';
    params.push(req.user.tenant_id);
  }

  query += ' ORDER BY e.created_at DESC';

  const events = db.prepare(query).all(...params);

  // Fetch tiers for each event
  const getTiers = db.prepare('SELECT * FROM ticket_tiers WHERE event_id = ? ORDER BY price DESC');
  for (const event of events) {
    event.tiers = getTiers.all(event.id);
  }

  await cache.set(cacheKey, events, 20); // 20s TTL
  res.json({ events, source: 'database' });
});

// Get single event with tiers - Cached
app.get('/api/events/:id', async (req, res) => {
  const eventId = req.params.id;
  const cacheKey = `event:${eventId}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json({ event: cached, source: 'cache' });
  }

  const event = db.prepare(`
    SELECT e.*, u.name as organizer_name 
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  event.tiers = db.prepare('SELECT * FROM ticket_tiers WHERE event_id = ? ORDER BY price DESC').all(eventId);

  await cache.set(cacheKey, event, 30);
  res.json({ event, source: 'database' });
});

// Create new event with ticket tiers (RBAC: ORGANIZER, ADMIN)
app.post('/api/events', requireRole(['ORGANIZER', 'ADMIN']), async (req, res) => {
  const { title, description, venue, event_date, sales_cutoff_date, tiers } = req.body;

  if (!title || !venue || !event_date || !sales_cutoff_date || !Array.isArray(tiers) || tiers.length === 0) {
    return res.status(400).json({ error: 'Missing required event fields or ticket tiers' });
  }

  const eventId = 'evt_' + Math.random().toString(36).substring(2, 10);
  const tenantId = req.user.tenant_id;
  const organizerId = req.user.id;

  try {
    db.exec('BEGIN IMMEDIATE');

    db.prepare(`
      INSERT INTO events (id, tenant_id, organizer_id, title, description, venue, event_date, sales_cutoff_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(eventId, tenantId, organizerId, title, description || '', venue, event_date, sales_cutoff_date);

    const insertTier = db.prepare(`
      INSERT INTO ticket_tiers (id, event_id, name, price, total_capacity, available_capacity, reserved_capacity)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);

    for (const tier of tiers) {
      const tierId = 'tier_' + Math.random().toString(36).substring(2, 10);
      const capacity = parseInt(tier.capacity || tier.total_capacity, 10);
      const price = parseFloat(tier.price);

      if (isNaN(capacity) || capacity <= 0 || isNaN(price) || price < 0) {
        throw new Error(`Invalid capacity or price for tier "${tier.name}"`);
      }

      insertTier.run(tierId, eventId, tier.name, price, capacity, capacity);
    }

    db.exec('COMMIT');

    // Invalidate cache
    await cache.invalidatePattern('events:');

    res.status(201).json({
      message: 'Event and ticket tiers created successfully',
      eventId,
      tenantId
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: 'Failed to create event', details: err.message });
  }
});

// -------------------------------------------------------------
// 3. Reservation Engine (10-minute hold & Atomic Lock)
// -------------------------------------------------------------

// Place tickets on temporary reservation hold
app.post('/api/reservations/hold', async (req, res) => {
  const { tier_id, quantity = 1, hold_minutes = 10 } = req.body;
  const qty = parseInt(quantity, 10);

  if (!tier_id || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Invalid tier_id or quantity' });
  }

  try {
    // ATOMIC TRANSACTION WITH EXCLUSIVE WRITER LOCK
    db.exec('BEGIN IMMEDIATE');

    // 1. Fetch tier with event sales cutoff and status
    const tier = db.prepare(`
      SELECT t.*, e.id as event_id, e.title as event_title, e.sales_cutoff_date, e.status as event_status, e.tenant_id
      FROM ticket_tiers t
      JOIN events e ON t.event_id = e.id
      WHERE t.id = ?
    `).get(tier_id);

    if (!tier) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Ticket tier not found' });
    }

    if (tier.event_status !== 'ACTIVE') {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: `Event is ${tier.event_status}, tickets unavailable` });
    }

    if (new Date(tier.sales_cutoff_date) < new Date()) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Sales cutoff date has passed. Bookings closed.' });
    }

    // 2. Concurrency check: Atomic capacity validation
    if (tier.available_capacity < qty) {
      db.exec('ROLLBACK');
      return res.status(409).json({
        error: 'Insufficient tickets',
        available: tier.available_capacity,
        requested: qty,
        message: tier.available_capacity === 0 
          ? 'This tier is completely sold out or on hold!' 
          : `Only ${tier.available_capacity} ticket(s) remaining.`
      });
    }

    // 3. Decrement available capacity and increment reserved capacity
    db.prepare(`
      UPDATE ticket_tiers
      SET available_capacity = available_capacity - ?,
          reserved_capacity = reserved_capacity + ?
      WHERE id = ?
    `).run(qty, qty, tier_id);

    // 4. Create 10-minute Hold Record
    const holdId = 'hld_' + Math.random().toString(36).substring(2, 11);
    const expiresAt = new Date(Date.now() + hold_minutes * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO reservation_holds (id, tenant_id, tier_id, user_id, quantity, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'HOLD')
    `).run(holdId, tier.tenant_id, tier_id, req.user.id, qty, expiresAt);

    db.exec('COMMIT');

    // 5. Invalidate Event Cache
    await cache.del(`event:${tier.event_id}`);
    await cache.invalidatePattern('events:');

    res.status(201).json({
      message: `Reservation hold placed for ${hold_minutes} minutes.`,
      holdId,
      tierId: tier.id,
      tierName: tier.name,
      unitPrice: tier.price,
      quantity: qty,
      totalAmount: tier.price * qty,
      expiresAt,
      holdMinutes: hold_minutes
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: 'Transaction failed', details: err.message });
  }
});

// Inspect Hold
app.get('/api/reservations/:id', (req, res) => {
  const hold = db.prepare(`
    SELECT h.*, t.name as tier_name, t.price, e.title as event_title, e.id as event_id
    FROM reservation_holds h
    JOIN ticket_tiers t ON h.tier_id = t.id
    JOIN events e ON t.event_id = e.id
    WHERE h.id = ?
  `).get(req.params.id);

  if (!hold) {
    return res.status(404).json({ error: 'Reservation hold not found' });
  }

  const isExpired = new Date(hold.expires_at) < new Date();
  const remainingSeconds = Math.max(0, Math.floor((new Date(hold.expires_at) - new Date()) / 1000));

  res.json({
    hold: {
      ...hold,
      isExpired,
      remainingSeconds,
      totalAmount: hold.price * hold.quantity
    }
  });
});

// Release Hold manually (Attendee cancel)
app.post('/api/reservations/release', async (req, res) => {
  const { hold_id } = req.body;
  if (!hold_id) return res.status(400).json({ error: 'hold_id is required' });

  try {
    db.exec('BEGIN IMMEDIATE');

    const hold = db.prepare('SELECT * FROM reservation_holds WHERE id = ?').get(hold_id);
    if (!hold) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Hold not found' });
    }

    if (hold.status !== 'HOLD') {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: `Hold is already in ${hold.status} status` });
    }

    db.prepare("UPDATE reservation_holds SET status = 'RELEASED' WHERE id = ?").run(hold_id);
    db.prepare(`
      UPDATE ticket_tiers
      SET available_capacity = available_capacity + ?,
          reserved_capacity = MAX(0, reserved_capacity - ?)
      WHERE id = ?
    `).run(hold.quantity, hold.quantity, hold.tier_id);

    db.exec('COMMIT');

    const tier = db.prepare('SELECT event_id FROM ticket_tiers WHERE id = ?').get(hold.tier_id);
    if (tier) await cache.del(`event:${tier.event_id}`);
    await cache.invalidatePattern('events:');

    res.json({ message: 'Reservation hold released and tickets restored to inventory.' });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: 'Failed to release hold', details: err.message });
  }
});

// -------------------------------------------------------------
// 4. Payment Simulation & Checkout
// -------------------------------------------------------------
app.post('/api/checkout', async (req, res) => {
  const { hold_id, simulated_payment_status = 'SUCCESS' } = req.body;

  if (!hold_id) {
    return res.status(400).json({ error: 'hold_id is required' });
  }

  try {
    db.exec('BEGIN IMMEDIATE');

    const hold = db.prepare(`
      SELECT h.*, t.price, t.name as tier_name, t.event_id, e.title as event_title, e.tenant_id
      FROM reservation_holds h
      JOIN ticket_tiers t ON h.tier_id = t.id
      JOIN events e ON t.event_id = e.id
      WHERE h.id = ?
    `).get(hold_id);

    if (!hold) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Reservation hold not found' });
    }

    if (hold.status !== 'HOLD') {
      db.exec('ROLLBACK');
      return res.status(400).json({
        error: `Reservation hold cannot be checked out because it is '${hold.status}'.`
      });
    }

    // Check expiration
    if (new Date(hold.expires_at) < new Date()) {
      // Mark expired and restore capacity
      db.prepare("UPDATE reservation_holds SET status = 'EXPIRED' WHERE id = ?").run(hold_id);
      db.prepare(`
        UPDATE ticket_tiers
        SET available_capacity = available_capacity + ?,
            reserved_capacity = MAX(0, reserved_capacity - ?)
        WHERE id = ?
      `).run(hold.quantity, hold.quantity, hold.tier_id);

      db.exec('COMMIT');
      await cache.del(`event:${hold.event_id}`);

      return res.status(410).json({
        error: 'Reservation hold has expired (10-minute limit exceeded). Tickets were returned to inventory.'
      });
    }

    const totalAmount = hold.price * hold.quantity;
    const orderId = 'ord_' + Math.random().toString(36).substring(2, 10);
    const txId = 'tx_' + Math.random().toString(36).substring(2, 10);
    const paymentIntentId = 'pi_' + Math.random().toString(36).substring(2, 12);

    if (simulated_payment_status === 'SUCCESS') {
      // 1. Convert hold
      db.prepare("UPDATE reservation_holds SET status = 'CONVERTED' WHERE id = ?").run(hold_id);

      // 2. Reserved capacity is now sold: decrement reserved_capacity
      db.prepare(`
        UPDATE ticket_tiers
        SET reserved_capacity = MAX(0, reserved_capacity - ?)
        WHERE id = ?
      `).run(hold.quantity, hold.tier_id);

      // 3. Create paid order
      db.prepare(`
        INSERT INTO orders (id, tenant_id, user_id, event_id, hold_id, total_amount, status)
        VALUES (?, ?, ?, ?, ?, ?, 'PAID')
      `).run(orderId, hold.tenant_id, req.user.id, hold.event_id, hold_id, totalAmount);

      // 4. Create order item
      db.prepare(`
        INSERT INTO order_items (id, order_id, tier_id, quantity, unit_price)
        VALUES (?, ?, ?, ?, ?)
      `).run('item_' + Math.random().toString(36).substring(2, 10), orderId, hold.tier_id, hold.quantity, hold.price);

      // 5. Create transaction record
      db.prepare(`
        INSERT INTO transactions (id, order_id, payment_intent_id, amount, status, gateway_reference)
        VALUES (?, ?, ?, ?, 'SUCCESS', ?)
      `).run(txId, orderId, paymentIntentId, totalAmount, 'MOCK_AUTH_200_APPROVED');

      db.exec('COMMIT');

      await cache.del(`event:${hold.event_id}`);
      await cache.invalidatePattern('events:');

      res.status(200).json({
        success: true,
        message: 'Order confirmed and payment simulated successfully!',
        order: {
          orderId,
          transactionId: txId,
          paymentIntentId,
          eventTitle: hold.event_title,
          tierName: hold.tier_name,
          quantity: hold.quantity,
          unitPrice: hold.price,
          totalAmount,
          status: 'PAID',
          purchaserId: req.user.id,
          purchaserEmail: req.user.email
        }
      });
    } else {
      // Payment Failed: release reserved tickets back to available
      db.prepare("UPDATE reservation_holds SET status = 'RELEASED' WHERE id = ?").run(hold_id);

      db.prepare(`
        UPDATE ticket_tiers
        SET available_capacity = available_capacity + ?,
            reserved_capacity = MAX(0, reserved_capacity - ?)
        WHERE id = ?
      `).run(hold.quantity, hold.quantity, hold.tier_id);

      db.prepare(`
        INSERT INTO orders (id, tenant_id, user_id, event_id, hold_id, total_amount, status)
        VALUES (?, ?, ?, ?, ?, ?, 'FAILED')
      `).run(orderId, hold.tenant_id, req.user.id, hold.event_id, hold_id, totalAmount);

      db.prepare(`
        INSERT INTO transactions (id, order_id, payment_intent_id, amount, status, gateway_reference, error_message)
        VALUES (?, ?, ?, ?, 'FAILED', ?, ?)
      `).run(txId, orderId, paymentIntentId, totalAmount, 'MOCK_DECLINED_402', 'Simulated bank card decline');

      db.exec('COMMIT');

      await cache.del(`event:${hold.event_id}`);
      await cache.invalidatePattern('events:');

      res.status(402).json({
        success: false,
        error: 'Payment declined by simulated gateway.',
        orderId,
        transactionId: txId,
        status: 'FAILED',
        message: 'Your payment was declined. The temporary hold has been released.'
      });
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    res.status(500).json({ error: 'Checkout failed', details: err.message });
  }
});

// Standalone mock payment gateway endpoint
app.post('/api/payments/mock-gateway', (req, res) => {
  const { amount, currency = 'USD', simulate_decline = false, delay_ms = 100 } = req.body;

  setTimeout(() => {
    if (simulate_decline) {
      return res.status(402).json({
        status: 'DECLINED',
        reason: 'CARD_DECLINED_INSUFFICIENT_FUNDS',
        code: 402,
        gateway_ref: 'GW_ERR_' + Math.random().toString(36).substring(2, 8).toUpperCase()
      });
    }

    res.json({
      status: 'APPROVED',
      auth_code: 'AUTH_' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      amount,
      currency,
      timestamp: new Date().toISOString()
    });
  }, delay_ms);
});

// -------------------------------------------------------------
// 5. Concurrency Race Condition Simulator
// -------------------------------------------------------------
app.post('/api/reservations/simulate-concurrency', async (req, res) => {
  const { tier_id, total_attempts = 10, quantity = 1 } = req.body;

  if (!tier_id) return res.status(400).json({ error: 'tier_id is required' });

  const initialTier = db.prepare('SELECT * FROM ticket_tiers WHERE id = ?').get(tier_id);
  if (!initialTier) return res.status(404).json({ error: 'Tier not found' });

  const initialAvailable = initialTier.available_capacity;

  // Run simultaneous booking attempts
  const attempts = Array.from({ length: total_attempts }, (_, i) => ({
    userId: `sim_user_${i + 1}`
  }));

  const results = await Promise.all(
    attempts.map(async (attempt) => {
      try {
        db.exec('BEGIN IMMEDIATE');

        const currentTier = db.prepare('SELECT available_capacity, reserved_capacity FROM ticket_tiers WHERE id = ?').get(tier_id);
        
        if (currentTier.available_capacity < quantity) {
          db.exec('ROLLBACK');
          return {
            userId: attempt.userId,
            success: false,
            status: 409,
            reason: 'CAPACITY_EXCEEDED'
          };
        }

        db.prepare(`
          UPDATE ticket_tiers
          SET available_capacity = available_capacity - ?,
              reserved_capacity = reserved_capacity + ?
          WHERE id = ?
        `).run(quantity, quantity, tier_id);

        const holdId = 'hld_sim_' + Math.random().toString(36).substring(2, 8);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        db.prepare('INSERT OR IGNORE INTO users (id, tenant_id, name, email, role) VALUES (?, ?, ?, ?, ?)')
          .run(attempt.userId, 'tenant_acme', attempt.userId, `${attempt.userId}@sim.com`, 'ATTENDEE');

        db.prepare(`
          INSERT INTO reservation_holds (id, tenant_id, tier_id, user_id, quantity, expires_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'HOLD')
        `).run(holdId, 'tenant_acme', tier_id, attempt.userId, quantity, expiresAt);

        db.exec('COMMIT');

        return {
          userId: attempt.userId,
          success: true,
          status: 201,
          holdId
        };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (e) {}
        return {
          userId: attempt.userId,
          success: false,
          status: 500,
          reason: err.message
        };
      }
    })
  );

  const finalTier = db.prepare('SELECT * FROM ticket_tiers WHERE id = ?').get(tier_id);
  await cache.invalidatePattern('events:');

  const successfulCount = results.filter(r => r.success).length;
  const rejectedCount = results.filter(r => !r.success).length;

  res.json({
    message: 'Concurrency race condition simulation completed',
    tierId: tier_id,
    initialAvailableCapacity: initialAvailable,
    concurrentAttemptsFired: total_attempts,
    successfulHolds: successfulCount,
    rejectedAttempts: rejectedCount,
    finalAvailableCapacity: finalTier.available_capacity,
    finalReservedCapacity: finalTier.reserved_capacity,
    preventedDoubleBooking: (successfulCount * quantity) <= initialAvailable,
    attempts: results
  });
});

// -------------------------------------------------------------
// 6. Analytics Dashboard (Organizer & Admin)
// -------------------------------------------------------------
app.get('/api/analytics/organizer', (req, res) => {
  const tenantId = req.user.tenant_id;

  // 1. Total Revenue
  const rev = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_paid_orders
    FROM orders
    WHERE tenant_id = ? AND status = 'PAID'
  `).get(tenantId);

  // 2. Holds & Conversion
  const holdsStats = db.prepare(`
    SELECT 
      COUNT(*) as total_holds,
      SUM(CASE WHEN status = 'CONVERTED' THEN 1 ELSE 0 END) as converted_holds,
      SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_holds,
      SUM(CASE WHEN status = 'RELEASED' THEN 1 ELSE 0 END) as released_holds,
      SUM(CASE WHEN status = 'HOLD' THEN 1 ELSE 0 END) as active_holds
    FROM reservation_holds
    WHERE tenant_id = ?
  `).get(tenantId);

  const totalHolds = holdsStats.total_holds || 0;
  const converted = holdsStats.converted_holds || 0;
  const conversionRate = totalHolds > 0 ? ((converted / totalHolds) * 100).toFixed(1) : 0;

  // 3. Ticket Sales by Tier
  const tierBreakdown = db.prepare(`
    SELECT t.name as tier_name, t.price, t.total_capacity, t.available_capacity, t.reserved_capacity,
      (t.total_capacity - t.available_capacity - t.reserved_capacity) as sold_capacity,
      e.title as event_title
    FROM ticket_tiers t
    JOIN events e ON t.event_id = e.id
    WHERE e.tenant_id = ?
    ORDER BY t.created_at DESC
  `).all(tenantId);

  // 4. Recent Transactions
  const recentTransactions = db.prepare(`
    SELECT tx.id, tx.order_id, tx.amount, tx.status, tx.gateway_reference, tx.created_at,
           u.name as attendee_name, u.email as attendee_email, e.title as event_title
    FROM transactions tx
    JOIN orders o ON tx.order_id = o.id
    JOIN users u ON o.user_id = u.id
    JOIN events e ON o.event_id = e.id
    WHERE o.tenant_id = ?
    ORDER BY tx.created_at DESC
    LIMIT 10
  `).all(tenantId);

  res.json({
    tenantId,
    totalRevenue: rev.total_revenue,
    totalPaidOrders: rev.total_paid_orders,
    totalHolds,
    convertedHolds: converted,
    activeHolds: holdsStats.active_holds || 0,
    expiredHolds: holdsStats.expired_holds || 0,
    releasedHolds: holdsStats.released_holds || 0,
    conversionRate: Number(conversionRate),
    tierBreakdown,
    recentTransactions
  });
});

// Platform Admin Analytics
app.get('/api/analytics/admin', requireRole(['ADMIN']), (req, res) => {
  const globalRev = db.prepare("SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE status = 'PAID'").get().total;
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const activeHolds = db.prepare("SELECT COUNT(*) as count FROM reservation_holds WHERE status = 'HOLD'").get().count;

  res.json({
    platformRevenue: globalRev,
    totalUsers,
    totalEvents,
    totalOrders,
    activeHolds,
    workerMetrics: worker.getMetrics(),
    cacheStats: cache.getStats()
  });
});

// -------------------------------------------------------------
// 7. Background Worker & Cache Controls
// -------------------------------------------------------------
app.get('/api/cache/stats', (req, res) => {
  res.json(cache.getStats());
});

app.post('/api/cache/flush', async (req, res) => {
  await cache.invalidatePattern('');
  res.json({ message: 'Cache flushed successfully' });
});

app.get('/api/admin/worker-status', (req, res) => {
  res.json(worker.getMetrics());
});

// Trigger worker sweep manually (Useful for instant testing of expired holds)
app.post('/api/admin/cleanup-holds', (req, res) => {
  const released = worker.sweep();
  res.json({
    message: `Manual background worker cleanup executed.`,
    releasedCount: released,
    workerMetrics: worker.getMetrics()
  });
});

// Fallback route for Single Page Application (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    const indexHtml = path.join(frontendDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return res.sendFile(indexHtml);
    }
  }
  next();
});

// Start background worker
worker.start();

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Event & Ticket Reservation System running on port ${PORT}`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
