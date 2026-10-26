const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'reservation_system.db');

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys for high performance and durability
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ORGANIZER', 'ATTENDEE')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organizer_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      venue TEXT NOT NULL,
      event_date TEXT NOT NULL,
      sales_cutoff_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CANCELLED', 'PAST')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organizer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_tiers (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      total_capacity INTEGER NOT NULL,
      available_capacity INTEGER NOT NULL,
      reserved_capacity INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS reservation_holds (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      tier_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'HOLD' CHECK(status IN ('HOLD', 'EXPIRED', 'RELEASED', 'CONVERTED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tier_id) REFERENCES ticket_tiers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      hold_id TEXT,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (hold_id) REFERENCES reservation_holds(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      tier_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (tier_id) REFERENCES ticket_tiers(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      payment_intent_id TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED')),
      gateway_reference TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_holds_status_exp ON reservation_holds(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tiers_event ON ticket_tiers(event_id);
  `);

  seedData();
}

function seedData() {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) return;

  console.log('[Database] Seeding initial users and sample event with tiers...');

  // 1. Seed Users (Admin, Organizer, Attendees)
  const insertUser = db.prepare(`
    INSERT INTO users (id, tenant_id, name, email, role) VALUES (?, ?, ?, ?, ?)
  `);

  insertUser.run('usr_admin_1', 'tenant_platform', 'System Administrator', 'admin@eventhub.com', 'ADMIN');
  insertUser.run('usr_org_1', 'tenant_acme', 'Sarah Connor (Acme Events)', 'organizer@acmeevents.com', 'ORGANIZER');
  insertUser.run('usr_org_2', 'tenant_apex', 'David Miller (Apex Music)', 'david@apexmusic.com', 'ORGANIZER');
  insertUser.run('usr_att_1', 'tenant_acme', 'Alice Johnson', 'alice@gmail.com', 'ATTENDEE');
  insertUser.run('usr_att_2', 'tenant_acme', 'Bob Williams', 'bob@gmail.com', 'ATTENDEE');

  // 2. Seed Sample Event
  const now = new Date();
  const eventDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffDate = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();

  const insertEvent = db.prepare(`
    INSERT INTO events (id, tenant_id, organizer_id, title, description, venue, event_date, sales_cutoff_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertEvent.run(
    'evt_tech_conf_2026',
    'tenant_acme',
    'usr_org_1',
    'Global Tech & AI Summit 2026',
    'The premier developer and AI architect summit with top industry leaders.',
    'San Francisco Grand Hall & Live Stream',
    eventDate,
    cutoffDate,
    'ACTIVE'
  );

  // 3. Seed Ticket Tiers
  const insertTier = db.prepare(`
    INSERT INTO ticket_tiers (id, event_id, name, price, total_capacity, available_capacity, reserved_capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertTier.run('tier_vip_1', 'evt_tech_conf_2026', 'VIP All-Access Pass', 299.99, 50, 50, 0);
  insertTier.run('tier_ga_1', 'evt_tech_conf_2026', 'General Admission', 99.99, 200, 200, 0);
  insertTier.run('tier_early_1', 'evt_tech_conf_2026', 'Early Bird Limited', 49.99, 10, 10, 0);

  console.log('[Database] Seed completed successfully.');
}

initSchema();

module.exports = {
  db,
  initSchema
};
