# Entity-Relationship (ER) Diagram & Data Architecture

## 1. System Overview
The **EventNest** multi-tenant ticket reservation platform ensures high-concurrency seat reservation integrity using ACID-compliant exclusive write transactions (`BEGIN IMMEDIATE` in SQLite / `SELECT FOR UPDATE` in PostgreSQL), temporary 10-minute reservation holds, an in-memory/Redis read caching layer, and an asynchronous background worker that automatically returns expired holds to available inventory.

---

## 2. Mermaid Entity-Relationship Diagram

```mermaid
erDiagram
    USERS ||--o{ EVENTS : "creates/manages (ORGANIZER)"
    USERS ||--o{ RESERVATION_HOLDS : "places"
    USERS ||--o{ ORDERS : "places (ATTENDEE)"

    EVENTS ||--|{ TICKET_TIERS : "contains"
    EVENTS ||--o{ ORDERS : "associated with"

    TICKET_TIERS ||--o{ RESERVATION_HOLDS : "holds capacity"
    TICKET_TIERS ||--o{ ORDER_ITEMS : "purchased as"

    RESERVATION_HOLDS ||--o| ORDERS : "converted into"

    ORDERS ||--|{ ORDER_ITEMS : "contains"
    ORDERS ||--|| TRANSACTIONS : "settled by"

    USERS {
        string id PK "Unique User ID (e.g., usr_org_1)"
        string tenant_id "Tenant/Organization Identifier"
        string name "Full Name"
        string email UK "User Email Address"
        string role "ADMIN | ORGANIZER | ATTENDEE"
        datetime created_at "Registration Timestamp"
    }

    EVENTS {
        string id PK "Unique Event ID (e.g., evt_123)"
        string tenant_id "Tenant Partition Key"
        string organizer_id FK "References USERS(id)"
        string title "Event Title"
        string description "Detailed Event Description"
        string venue "Physical Venue / Stream URL"
        datetime event_date "Date and Time of Event"
        datetime sales_cutoff_date "Deadline for Purchasing"
        string status "ACTIVE | CANCELLED | PAST"
        datetime created_at "Record Creation Timestamp"
    }

    TICKET_TIERS {
        string id PK "Unique Tier ID (e.g., tier_vip_1)"
        string event_id FK "References EVENTS(id)"
        string name "Tier Name (VIP, General, Early Bird)"
        float price "Unit Ticket Price in USD"
        int total_capacity "Total Seating Allotment"
        int available_capacity "Free Seats Available for Hold"
        int reserved_capacity "Seats Currently on Temporary Hold"
        datetime created_at "Creation Timestamp"
    }

    RESERVATION_HOLDS {
        string id PK "Unique Hold ID (e.g., hld_xyz)"
        string tenant_id "Tenant Identifier"
        string tier_id FK "References TICKET_TIERS(id)"
        string user_id FK "References USERS(id)"
        int quantity "Number of Seats on Hold"
        datetime expires_at "Hold Expiration Timestamp (Now + 10m)"
        string status "HOLD | EXPIRED | RELEASED | CONVERTED"
        datetime created_at "Hold Creation Timestamp"
    }

    ORDERS {
        string id PK "Unique Order ID (e.g., ord_abc)"
        string tenant_id "Tenant Identifier"
        string user_id FK "References USERS(id)"
        string event_id FK "References EVENTS(id)"
        string hold_id FK "References RESERVATION_HOLDS(id)"
        float total_amount "Total Billed Amount in USD"
        string status "PENDING | PAID | FAILED | CANCELLED"
        datetime created_at "Order Timestamp"
    }

    ORDER_ITEMS {
        string id PK "Item Line ID"
        string order_id FK "References ORDERS(id)"
        string tier_id FK "References TICKET_TIERS(id)"
        int quantity "Purchased Seat Count"
        float unit_price "Price per Ticket at Purchase"
    }

    TRANSACTIONS {
        string id PK "Transaction Record ID"
        string order_id FK "References ORDERS(id)"
        string payment_intent_id "Mock/Gateway Payment Intent"
        float amount "Settlement Amount in USD"
        string status "PENDING | SUCCESS | FAILED"
        string gateway_reference "Gateway Authorization / Error Code"
        string error_message "Failure Reason (if declined)"
        datetime created_at "Transaction Settlement Time"
    }
```

---

## 3. Data Dictionary & Constraints

| Table Name | Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- | :--- |
| `users` | `id` | `TEXT` | PRIMARY KEY | User identifier |
| `users` | `tenant_id` | `TEXT` | NOT NULL | Multi-tenant organization scoping |
| `users` | `email` | `TEXT` | UNIQUE, NOT NULL | Account contact |
| `users` | `role` | `TEXT` | CHECK in ('ADMIN', 'ORGANIZER', 'ATTENDEE') | Role-based authorization |
| `events` | `id` | `TEXT` | PRIMARY KEY | Event identifier |
| `events` | `organizer_id`| `TEXT` | FOREIGN KEY (`users.id`) | Event owner |
| `events` | `sales_cutoff_date` | `TEXT` | NOT NULL | Automatic cutoff gating bookings |
| `ticket_tiers`| `id` | `TEXT` | PRIMARY KEY | Tier identifier |
| `ticket_tiers`| `event_id` | `TEXT` | FOREIGN KEY (`events.id`) | Associated event |
| `ticket_tiers`| `available_capacity`| `INTEGER` | NOT NULL | Decremented atomically upon hold |
| `ticket_tiers`| `reserved_capacity` | `INTEGER` | DEFAULT 0 | Count of currently held seats |
| `reservation_holds` | `id` | `TEXT` | PRIMARY KEY | Hold reference |
| `reservation_holds` | `expires_at` | `TEXT` | NOT NULL | 10 minutes from creation |
| `reservation_holds` | `status` | `TEXT` | CHECK in ('HOLD', 'EXPIRED', 'RELEASED', 'CONVERTED') | Hold lifecycle flag |
| `orders` | `id` | `TEXT` | PRIMARY KEY | Order reference |
| `orders` | `status` | `TEXT` | CHECK in ('PENDING', 'PAID', 'FAILED', 'CANCELLED') | Order state |
| `transactions` | `id` | `TEXT` | PRIMARY KEY | Settlement reference |
| `transactions` | `order_id`| `TEXT` | FOREIGN KEY (`orders.id`) | Associated order |
| `transactions` | `status` | `TEXT` | CHECK in ('PENDING', 'SUCCESS', 'FAILED') | Payment gateway result |

---

## 4. State Lifecycle Models

### A. Reservation Hold Lifecycle
```
[User Selects Seats] 
       │
       ▼
 [HOLD CREATED] ─────────── (10 Minutes Pass / Worker Sweep) ───────► [EXPIRED]
       │                                                                  │
       │ (Checkout Complete)                                              ▼
       ├─────────────────────► [CONVERTED] ────────► [ORDER PAID]    (Inventory
       │                                                              Restored)
       ▼ (User Cancels or Payment Declines)
  [RELEASED] ─────────────────────────────────────────────────────────────┘
```

### B. Concurrency Double-Booking Protection Mechanism
1. When multiple booking requests hit the server concurrently for the same limited inventory:
2. The transaction acquires an immediate lock via `BEGIN IMMEDIATE`.
3. Reads `available_capacity` inside the lock.
4. If `available_capacity < requested`: immediately rolls back and returns `409 Conflict`.
5. If sufficient: decrements `available_capacity`, increments `reserved_capacity`, inserts hold record with `expires_at = now + 10m`, and commits.
6. This guarantees total allocated seats strictly equals available capacity with **0 race conditions**.
