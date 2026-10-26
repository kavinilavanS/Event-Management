/* ==============================================================
   EventNest Frontend Application Logic
   ============================================================== */

const state = {
  user: {
    id: 'usr_att_1',
    role: 'ATTENDEE',
    tenant_id: 'tenant_acme',
    name: 'Alice Johnson'
  },
  activeHold: null, // { holdId, tierId, tierName, unitPrice, quantity, totalAmount, expiresAt, holdMinutes }
  holdTimerInterval: null,
  events: [],
  currentTab: 'catalog'
};

// --------------------------------------------------------------
// API Configuration & Base URL (Supports Vercel -> Render)
// --------------------------------------------------------------
function getApiBaseUrl() {
  const saved = localStorage.getItem('EVENTNEST_API_BASE_URL');
  if (saved) return saved.replace(/\/+$/, '');
  if (window.EVENTNEST_API_BASE_URL) return window.EVENTNEST_API_BASE_URL.replace(/\/+$/, '');
  return '';
}

function updateApiStatus(isHealthy, label = null) {
  const dot = document.getElementById('apiStatusDot');
  const text = document.getElementById('apiStatusText');
  if (!dot || !text) return;

  if (label) {
    text.textContent = label;
  } else if (getApiBaseUrl()) {
    text.textContent = isHealthy ? 'Render: Online' : 'Render: Offline';
  } else {
    text.textContent = isHealthy ? 'Backend: Online' : 'Backend: Disconnected';
  }

  dot.className = isHealthy ? 'status-dot-green' : 'status-dot-red';
}

async function apiFetch(endpoint, options = {}) {
  const baseUrl = getApiBaseUrl();
  const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-user-id': state.user.id,
    'x-role': state.user.role,
    'x-tenant-id': state.user.tenant_id,
    ...(options.headers || {})
  };

  try {
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.ok) updateApiStatus(true);
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    console.error('API Error:', err);
    updateApiStatus(false);
    return { 
      status: 500, 
      ok: false, 
      data: { error: 'Failed to connect to backend. Please check your Render URL in Backend Settings.' } 
    };
  }
}

// --------------------------------------------------------------
// Toast Notification Engine
// --------------------------------------------------------------
function showToast(message, type = 'info', durationMs = 4500) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = type === 'success' ? '✓' : type === 'danger' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
  toast.innerHTML = `
    <span style="font-weight: 800; font-size: 1.1rem;">${icon}</span>
    <div class="toast-message">${message}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// --------------------------------------------------------------
// Navigation & Tab Switching
// --------------------------------------------------------------
function initNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      window.switchTab(target);
    });
  });
}

window.switchTab = function(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });

  // Tab-specific refreshes
  if (tabName === 'catalog') loadEvents();
  if (tabName === 'organizer') loadOrganizerAnalytics();
  if (tabName === 'admin') loadDiagnostics();
};

// --------------------------------------------------------------
// Persona Switcher
// --------------------------------------------------------------
function initPersonaSwitcher() {
  const selector = document.getElementById('personaSelector');
  const badgeRole = document.getElementById('badgeRole');
  const badgeTenant = document.getElementById('badgeTenant');

  selector.addEventListener('change', (e) => {
    const opt = selector.selectedOptions[0];
    state.user.id = opt.value;
    state.user.role = opt.dataset.role;
    state.user.tenant_id = opt.dataset.tenant;
    state.user.name = opt.dataset.name;

    badgeRole.textContent = state.user.role;
    badgeRole.className = `badge-role role-${state.user.role.toLowerCase()}`;
    badgeTenant.textContent = state.user.tenant_id;

    showToast(`Switched persona to: <strong>${state.user.name}</strong> (${state.user.role})`, 'info');

    // Refresh context-dependent views
    loadEvents();
    if (state.currentTab === 'organizer') loadOrganizerAnalytics();
    if (state.currentTab === 'admin') loadDiagnostics();
  });
}

// --------------------------------------------------------------
// 1. Events Catalog
// --------------------------------------------------------------
async function loadEvents() {
  const grid = document.getElementById('eventsGrid');
  const sourceIndicator = document.getElementById('cacheSourceText');
  sourceIndicator.textContent = 'fetching...';

  const res = await apiFetch('/api/events');
  if (!res.ok) {
    grid.innerHTML = `<div class="empty-state-card"><p class="text-danger">Failed to load events: ${res.data.error || 'Unknown error'}</p></div>`;
    return;
  }

  state.events = res.data.events || [];
  sourceIndicator.textContent = res.data.source === 'cache' ? 'RAM / Redis Cache (Fast)' : 'SQLite Database';
  sourceIndicator.style.color = res.data.source === 'cache' ? '#38bdf8' : '#a5b4fc';

  if (state.events.length === 0) {
    grid.innerHTML = `
      <div class="empty-state-card" style="grid-column: 1 / -1;">
        <div class="empty-icon">🎪</div>
        <h3>No Events Available for this Tenant</h3>
        <p>Switch to an Organizer persona to create the first event for this tenant.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.events.map(event => {
    const eventDate = new Date(event.event_date).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const cutoffDate = new Date(event.sales_cutoff_date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const isCutoffPassed = new Date(event.sales_cutoff_date) < new Date();

    const tiersHtml = (event.tiers || []).map(tier => {
      const isSoldOut = tier.available_capacity <= 0;
      return `
        <div class="tier-item">
          <div class="tier-info">
            <span class="tier-name">${tier.name}</span>
            <span class="tier-price">$${tier.price.toFixed(2)}</span>
            <span class="tier-capacity">
              Available: <strong>${tier.available_capacity}</strong> / ${tier.total_capacity}
              ${tier.reserved_capacity > 0 ? `<span class="text-warning">(${tier.reserved_capacity} on hold)</span>` : ''}
            </span>
          </div>
          <div class="tier-actions">
            <select id="qty_${tier.id}" class="qty-select" ${isSoldOut || isCutoffPassed ? 'disabled' : ''}>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </select>
            <button class="btn btn-sm btn-primary" 
              onclick="placeHold('${tier.id}')"
              ${isSoldOut || isCutoffPassed ? 'disabled' : ''}>
              ${isCutoffPassed ? 'Sales Closed' : isSoldOut ? 'Sold Out' : 'Hold Seats'}
            </button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="event-card">
        <div class="event-card-header">
          <span class="event-status-badge ${event.status.toLowerCase()}">${event.status}</span>
          <h3>${event.title}</h3>
          <div class="event-meta">
            <div class="event-meta-item">
              <span>📅</span>
              <span>${eventDate}</span>
            </div>
            <div class="event-meta-item">
              <span>📍</span>
              <span>${event.venue}</span>
            </div>
            <div class="event-meta-item">
              <span>⏰ Cutoff:</span>
              <span class="${isCutoffPassed ? 'text-danger' : 'text-muted'}">${cutoffDate}</span>
            </div>
            <div class="event-meta-item">
              <span>🎪 Organizer:</span>
              <span class="text-muted">${event.organizer_name || 'Acme Organizers'} (${event.tenant_id})</span>
            </div>
          </div>
        </div>
        <div class="event-card-body">
          <div class="tiers-heading">Ticket Tiers & Real-Time Availability</div>
          <div class="tier-list">
            ${tiersHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// --------------------------------------------------------------
// 2. Reservation Hold Lifecycle & 10-Minute Timer
// --------------------------------------------------------------
window.placeHold = async function(tierId) {
  const qtySelect = document.getElementById(`qty_${tierId}`);
  const quantity = qtySelect ? parseInt(qtySelect.value, 10) : 1;

  const res = await apiFetch('/api/reservations/hold', {
    method: 'POST',
    body: JSON.stringify({ tier_id: tierId, quantity, hold_minutes: 10 })
  });

  if (!res.ok) {
    if (res.status === 409) {
      showToast(`<strong>409 Conflict:</strong> ${res.data.message || 'Insufficient ticket inventory.'}`, 'danger', 6000);
    } else {
      showToast(`Hold error: ${res.data.error || 'Failed to place reservation hold.'}`, 'danger');
    }
    loadEvents();
    return;
  }

  // Hold placed successfully
  state.activeHold = {
    holdId: res.data.holdId,
    tierId: res.data.tierId,
    tierName: res.data.tierName,
    unitPrice: res.data.unitPrice,
    quantity: res.data.quantity,
    totalAmount: res.data.totalAmount,
    expiresAt: res.data.expiresAt,
    holdMinutes: res.data.holdMinutes || 10
  };

  saveHoldState();
  startHoldCountdown();
  showToast(`🎟️ Reserved <strong>${res.data.quantity} seat(s)</strong> on temporary hold! 10-min countdown started.`, 'success');
  loadEvents();
  window.switchTab('checkout');
};

function startHoldCountdown() {
  if (state.holdTimerInterval) clearInterval(state.holdTimerInterval);

  const globalAlert = document.getElementById('globalHoldAlert');
  const cartBadge = document.getElementById('cartHoldCount');
  const noHoldCard = document.getElementById('noHoldCard');
  const activeHoldContainer = document.getElementById('activeHoldContainer');
  const orderReceiptCard = document.getElementById('orderReceiptCard');

  if (!state.activeHold) {
    globalAlert.classList.add('hidden');
    cartBadge.classList.add('hidden');
    noHoldCard.classList.remove('hidden');
    activeHoldContainer.classList.add('hidden');
    return;
  }

  // Populate Active Hold UI
  globalAlert.classList.remove('hidden');
  cartBadge.classList.remove('hidden');
  cartBadge.textContent = '1';
  noHoldCard.classList.add('hidden');
  activeHoldContainer.classList.remove('hidden');
  orderReceiptCard.classList.add('hidden');

  document.getElementById('globalHoldTierName').textContent = `${state.activeHold.tierName} (${state.activeHold.quantity} seat${state.activeHold.quantity > 1 ? 's' : ''})`;
  document.getElementById('holdTierName').textContent = state.activeHold.tierName;
  document.getElementById('summaryHoldId').textContent = state.activeHold.holdId;
  document.getElementById('summaryQuantity').textContent = `${state.activeHold.quantity} seat${state.activeHold.quantity > 1 ? 's' : ''}`;
  document.getElementById('summaryUnitPrice').textContent = `$${state.activeHold.unitPrice.toFixed(2)}`;
  document.getElementById('summaryTotalAmount').textContent = `$${state.activeHold.totalAmount.toFixed(2)}`;

  const expiryDate = new Date(state.activeHold.expiresAt);
  document.getElementById('holdExpiryTimeFormatted').textContent = `Expires at ${expiryDate.toLocaleTimeString()}`;

  const totalSeconds = (state.activeHold.holdMinutes || 10) * 60;

  function updateTimer() {
    const now = Date.now();
    const remainingMs = expiryDate.getTime() - now;
    const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));

    const minutes = Math.floor(remainingSec / 60);
    const seconds = remainingSec % 60;
    const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    document.getElementById('globalHoldTimeRemaining').textContent = formatted;
    document.getElementById('holdBigCountdown').textContent = formatted;

    const percent = Math.min(100, Math.max(0, (remainingSec / totalSeconds) * 100));
    document.getElementById('globalHoldProgressBar').style.width = `${percent}%`;
    document.getElementById('holdBigProgressBar').style.width = `${percent}%`;

    // Visual urgency indicators
    if (remainingSec < 120) {
      document.getElementById('holdBigCountdown').style.color = '#ef4444';
      document.getElementById('globalHoldTimeRemaining').style.color = '#ef4444';
    } else {
      document.getElementById('holdBigCountdown').style.color = '#fbbf24';
      document.getElementById('globalHoldTimeRemaining').style.color = '#fbbf24';
    }

    if (remainingSec <= 0) {
      clearInterval(state.holdTimerInterval);
      showToast('⌛ Your 10-minute hold has expired! The background worker has restored tickets to inventory.', 'warning', 7000);
      clearHoldState();
      loadEvents();
    }
  }

  updateTimer();
  state.holdTimerInterval = setInterval(updateTimer, 1000);
}

function clearHoldState() {
  if (state.holdTimerInterval) clearInterval(state.holdTimerInterval);
  state.activeHold = null;
  localStorage.removeItem('eventnest_active_hold');

  document.getElementById('globalHoldAlert').classList.add('hidden');
  document.getElementById('cartHoldCount').classList.add('hidden');
  document.getElementById('noHoldCard').classList.remove('hidden');
  document.getElementById('activeHoldContainer').classList.add('hidden');
}

function saveHoldState() {
  if (state.activeHold) {
    localStorage.setItem('eventnest_active_hold', JSON.stringify(state.activeHold));
  }
}

function restoreHoldState() {
  const saved = localStorage.getItem('eventnest_active_hold');
  if (saved) {
    try {
      const hold = JSON.parse(saved);
      if (new Date(hold.expiresAt) > new Date()) {
        state.activeHold = hold;
        startHoldCountdown();
      } else {
        localStorage.removeItem('eventnest_active_hold');
      }
    } catch (e) {}
  }
}

// --------------------------------------------------------------
// 3. Checkout Simulation & Manual Release
// --------------------------------------------------------------
function initCheckoutActions() {
  // Successful Checkout
  document.getElementById('btnPaySuccess').addEventListener('click', async () => {
    if (!state.activeHold) return;

    const holdId = state.activeHold.holdId;
    const res = await apiFetch('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ hold_id: holdId, simulated_payment_status: 'SUCCESS' })
    });

    if (!res.ok) {
      showToast(`Checkout failed: ${res.data.error || 'Server error'}`, 'danger');
      if (res.status === 410) {
        clearHoldState();
        loadEvents();
      }
      return;
    }

    const order = res.data.order;
    showToast(`🎉 Order Paid & Confirmed! Transaction ID: <strong>${order.transactionId}</strong>`, 'success', 6000);

    // Show Receipt
    const receiptCard = document.getElementById('orderReceiptCard');
    const receiptContent = document.getElementById('receiptContent');
    receiptContent.innerHTML = `
      <div><strong>Order ID:</strong> ${order.orderId}</div>
      <div><strong>Transaction ID:</strong> ${order.transactionId}</div>
      <div><strong>Payment Intent:</strong> ${order.paymentIntentId}</div>
      <div><strong>Event:</strong> ${order.eventTitle}</div>
      <div><strong>Tier / Seats:</strong> ${order.tierName} (${order.quantity} ticket${order.quantity > 1 ? 's' : ''})</div>
      <div><strong>Total Amount Settled:</strong> $${order.totalAmount.toFixed(2)} USD</div>
      <div><strong>Purchaser:</strong> ${order.purchaserEmail} (${order.purchaserId})</div>
      <div><strong>Status:</strong> <span class="badge badge-success">${order.status}</span></div>
      <div style="margin-top: 0.75rem; color: #10b981;">✓ Atomic hold converted, reserved inventory permanently sold.</div>
    `;
    receiptCard.classList.remove('hidden');

    clearHoldState();
    loadEvents();
    if (state.currentTab === 'organizer') loadOrganizerAnalytics();
  });

  // Simulated Card Decline (402 Rollback)
  document.getElementById('btnPayDecline').addEventListener('click', async () => {
    if (!state.activeHold) return;

    const holdId = state.activeHold.holdId;
    const res = await apiFetch('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ hold_id: holdId, simulated_payment_status: 'FAIL' })
    });

    showToast(`<strong>Simulated Payment Declined (402):</strong> The temporary hold was cancelled and tickets were restored to available inventory!`, 'warning', 7000);

    clearHoldState();
    loadEvents();
    if (state.currentTab === 'organizer') loadOrganizerAnalytics();
  });

  // Manual Release
  const releaseAction = async () => {
    if (!state.activeHold) return;
    const res = await apiFetch('/api/reservations/release', {
      method: 'POST',
      body: JSON.stringify({ hold_id: state.activeHold.holdId })
    });

    if (res.ok) {
      showToast('Reservation hold released. Seats returned to event inventory.', 'info');
    }
    clearHoldState();
    loadEvents();
  };

  document.getElementById('btnCancelHold').addEventListener('click', releaseAction);
  document.getElementById('btnQuickRelease').addEventListener('click', releaseAction);
  document.getElementById('btnQuickGoToHold').addEventListener('click', () => window.switchTab('checkout'));
}

// --------------------------------------------------------------
// 4. Organizer Studio & Analytics
// --------------------------------------------------------------
async function loadOrganizerAnalytics() {
  const res = await apiFetch('/api/analytics/organizer');
  if (!res.ok) {
    showToast('Failed to load organizer analytics.', 'danger');
    return;
  }

  const d = res.data;
  document.getElementById('kpiRevenue').textContent = `$${(d.totalRevenue || 0).toFixed(2)}`;
  document.getElementById('kpiPaidOrders').textContent = d.totalPaidOrders || 0;
  document.getElementById('kpiConversionRate').textContent = `${d.conversionRate || 0}%`;
  document.getElementById('kpiActiveHolds').textContent = d.activeHolds || 0;

  // Tier Breakdown Table
  const tbody = document.getElementById('tierBreakdownBody');
  if (!d.tierBreakdown || d.tierBreakdown.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No ticket tiers created for tenant '${d.tenantId}'.</td></tr>`;
  } else {
    tbody.innerHTML = d.tierBreakdown.map(t => {
      const sold = t.sold_capacity || 0;
      const utilPct = t.total_capacity > 0 ? ((sold / t.total_capacity) * 100).toFixed(0) : 0;
      return `
        <tr>
          <td><strong>${t.tier_name}</strong><br><span class="text-dim text-sm">${t.event_title}</span></td>
          <td class="mono">$${t.price.toFixed(2)}</td>
          <td>${t.total_capacity}</td>
          <td><strong class="text-success">${t.available_capacity}</strong></td>
          <td><strong class="${t.reserved_capacity > 0 ? 'text-warning' : 'text-muted'}">${t.reserved_capacity}</strong></td>
          <td><strong class="text-info">${sold}</strong></td>
          <td style="min-width: 140px;">
            <div style="font-size: 0.75rem; margin-bottom: 3px;">${utilPct}% Sold</div>
            <div class="timer-progress-track" style="height: 6px; border-radius: 4px; overflow: hidden;">
              <div style="height: 100%; width: ${utilPct}%; background: linear-gradient(90deg, #6366f1, #06b6d4);"></div>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Transactions Table
  const txBody = document.getElementById('transactionsBody');
  if (!d.recentTransactions || d.recentTransactions.length === 0) {
    txBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No transactions recorded yet.</td></tr>`;
  } else {
    txBody.innerHTML = d.recentTransactions.map(tx => {
      const isSuccess = tx.status === 'SUCCESS';
      const timeStr = new Date(tx.created_at).toLocaleTimeString();
      return `
        <tr>
          <td class="mono">${tx.id}</td>
          <td>${tx.event_title}</td>
          <td>${tx.attendee_name}<br><span class="text-dim text-sm">${tx.attendee_email}</span></td>
          <td class="mono"><strong>$${tx.amount.toFixed(2)}</strong></td>
          <td><span class="badge ${isSuccess ? 'badge-success' : 'badge-danger'}">${tx.status}</span></td>
          <td class="mono text-dim">${tx.gateway_reference || 'N/A'}</td>
          <td class="text-dim">${timeStr}</td>
        </tr>
      `;
    }).join('');
  }
}

// Create Event Modal & Form
function initEventCreation() {
  const modal = document.getElementById('createEventModal');
  const btnOpen = document.getElementById('btnOpenCreateEventModal');
  const btnClose = document.getElementById('btnCloseModal');
  const btnCancel = document.getElementById('btnCancelCreateEvent');
  const form = document.getElementById('createEventForm');
  const tiersContainer = document.getElementById('tiersContainer');
  const btnAddTier = document.getElementById('btnAddTierRow');

  function openModal() {
    if (state.user.role === 'ATTENDEE') {
      showToast('⚠️ Role is ATTENDEE. Switching you to ORGANIZER persona to test event creation.', 'warning');
      const selector = document.getElementById('personaSelector');
      selector.value = 'usr_org_1';
      selector.dispatchEvent(new Event('change'));
    }

    // Set default dates
    const now = new Date();
    const futureDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const cutoffDate = new Date(now.getTime() + 13 * 24 * 60 * 60 * 1000);

    document.getElementById('eventDate').value = futureDate.toISOString().slice(0, 16);
    document.getElementById('salesCutoff').value = cutoffDate.toISOString().slice(0, 16);

    tiersContainer.innerHTML = '';
    addTierRow('VIP Pass', 199.99, 25);
    addTierRow('General Admission', 79.99, 100);

    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function addTierRow(name = '', price = 50, capacity = 50) {
    const row = document.createElement('div');
    row.className = 'tier-row-item';
    row.innerHTML = `
      <input type="text" class="form-input tier-name-input" placeholder="Tier Name (e.g. Early Bird)" value="${name}" required>
      <input type="number" step="0.01" class="form-input tier-price-input" placeholder="Price ($)" value="${price}" required>
      <input type="number" class="form-input tier-capacity-input" placeholder="Capacity" value="${capacity}" required>
      <button type="button" class="btn btn-xs btn-outline-danger btn-remove-tier">&times;</button>
    `;
    row.querySelector('.btn-remove-tier').addEventListener('click', () => {
      if (tiersContainer.children.length > 1) row.remove();
      else showToast('Event must have at least one ticket tier.', 'warning');
    });
    tiersContainer.appendChild(row);
  }

  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);
  btnAddTier.addEventListener('click', () => addTierRow('', 49.99, 20));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = document.getElementById('eventTitle').value.trim();
    const description = document.getElementById('eventDescription').value.trim();
    const venue = document.getElementById('eventVenue').value.trim();
    const event_date = document.getElementById('eventDate').value;
    const sales_cutoff_date = document.getElementById('salesCutoff').value;

    const rows = tiersContainer.querySelectorAll('.tier-row-item');
    const tiers = Array.from(rows).map(row => ({
      name: row.querySelector('.tier-name-input').value.trim(),
      price: parseFloat(row.querySelector('.tier-price-input').value),
      capacity: parseInt(row.querySelector('.tier-capacity-input').value, 10)
    }));

    const res = await apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title, description, venue, event_date, sales_cutoff_date, tiers })
    });

    if (!res.ok) {
      showToast(`Creation failed: ${res.data.error || 'Server error'}`, 'danger');
      return;
    }

    showToast(`🎉 Event "${title}" published with ${tiers.length} ticket tiers!`, 'success');
    closeModal();
    loadEvents();
    if (state.currentTab === 'organizer') loadOrganizerAnalytics();
  });
}

// --------------------------------------------------------------
// 5. Concurrency Race Condition Lab
// --------------------------------------------------------------
function initConcurrencyLab() {
  const btnRun = document.getElementById('btnRunConcurrency');
  const resultsCard = document.getElementById('concurrencyResultsCard');

  btnRun.addEventListener('click', async () => {
    const tierId = document.getElementById('concurrencyTierSelect').value;
    const totalAttempts = parseInt(document.getElementById('concurrencyUserCount').value, 10);
    const quantity = parseInt(document.getElementById('concurrencyQty').value, 10);

    btnRun.disabled = true;
    btnRun.innerHTML = '⚡ Firing simultaneous atomic transactions...';

    const res = await apiFetch('/api/reservations/simulate-concurrency', {
      method: 'POST',
      body: JSON.stringify({ tier_id: tierId, total_attempts: totalAttempts, quantity })
    });

    btnRun.disabled = false;
    btnRun.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
      Launch Simultaneous Race Test
    `;

    if (!res.ok) {
      showToast(`Simulation error: ${res.data.error || 'Failed'}`, 'danger');
      return;
    }

    const d = res.data;
    resultsCard.classList.remove('hidden');

    document.getElementById('simInitialCapacity').textContent = d.initialAvailableCapacity;
    document.getElementById('simAttemptsFired').textContent = d.concurrentAttemptsFired;
    document.getElementById('simSuccessfulHolds').textContent = d.successfulHolds;
    document.getElementById('simRejectedAttempts').textContent = d.rejectedAttempts;
    document.getElementById('simFinalCapacity').textContent = d.finalAvailableCapacity;

    const badge = document.getElementById('doubleBookingBadge');
    if (d.preventedDoubleBooking) {
      badge.className = 'badge badge-success';
      badge.textContent = '✓ Zero Double-Booking Verified (BEGIN IMMEDIATE)';
    } else {
      badge.className = 'badge badge-danger';
      badge.textContent = '✕ Deficit Detected';
    }

    const grid = document.getElementById('simAttemptsGrid');
    grid.innerHTML = (d.attempts || []).map(att => {
      const isSuccess = att.success;
      return `
        <div class="attempt-card ${isSuccess ? 'success' : 'rejected'}">
          <span class="attempt-user">👤 ${att.userId}</span>
          <span class="attempt-status ${isSuccess ? 'text-success' : 'text-danger'}">
            ${isSuccess ? '✓ 201 Created' : '✕ 409 Conflict'}
          </span>
          <span class="text-dim text-sm">${isSuccess ? att.holdId : att.reason}</span>
        </div>
      `;
    }).join('');

    showToast(`Simulation complete: ${d.successfulHolds} succeeded, ${d.rejectedAttempts} blocked by exclusive writer lock.`, 'success', 5000);
    loadEvents();
  });
}

// --------------------------------------------------------------
// 6. Diagnostics & Background Worker Telemetry
// --------------------------------------------------------------
async function loadDiagnostics() {
  const [workerRes, cacheRes] = await Promise.all([
    apiFetch('/api/admin/worker-status'),
    apiFetch('/api/cache/stats')
  ]);

  if (workerRes.ok) {
    const w = workerRes.data;
    document.getElementById('workerTotalRuns').textContent = w.totalRuns;
    document.getElementById('workerTotalReleased').textContent = w.totalHoldsReleased;
    document.getElementById('workerLastRunTime').textContent = w.lastRunTime ? new Date(w.lastRunTime).toLocaleTimeString() : 'Pending first sweep';
    document.getElementById('workerLastCount').textContent = w.lastReleasedCount;
  }

  if (cacheRes.ok) {
    const c = cacheRes.data;
    document.getElementById('cacheEngineType').textContent = c.type === 'redis' ? 'Connected Redis Instance' : 'In-Memory TTL Store';
    document.getElementById('cacheHits').textContent = c.hits;
    document.getElementById('cacheMisses').textContent = c.misses;
    document.getElementById('cacheInvalidations').textContent = c.invalidations;
    document.getElementById('cacheKeyCount').textContent = c.inMemoryKeyCount ?? 0;
    document.getElementById('cacheUptime').textContent = `${c.uptimeSeconds}s`;
  }
}

function initDiagnosticsActions() {
  // Manual Sweep
  document.getElementById('btnManualSweep').addEventListener('click', async () => {
    const btn = document.getElementById('btnManualSweep');
    btn.disabled = true;

    const res = await apiFetch('/api/admin/cleanup-holds', { method: 'POST' });
    btn.disabled = false;

    if (res.ok) {
      showToast(`Worker sweep executed! Released <strong>${res.data.releasedCount}</strong> expired holds back to inventory.`, 'success');
      loadDiagnostics();
      loadEvents();
      if (state.currentTab === 'organizer') loadOrganizerAnalytics();
    }
  });

  // Flush Cache
  document.getElementById('btnFlushCache').addEventListener('click', async () => {
    const res = await apiFetch('/api/cache/flush', { method: 'POST' });
    if (res.ok) {
      showToast('Cache purged successfully! Next queries will hit the SQLite database.', 'info');
      loadDiagnostics();
      loadEvents();
    }
  });
}

// --------------------------------------------------------------
// API Base URL Modal (For Vercel deployment with Render)
// --------------------------------------------------------------
function initApiConfigModal() {
  const modal = document.getElementById('apiConfigModal');
  const btnOpen = document.getElementById('btnOpenApiConfig');
  const btnClose = document.getElementById('btnCloseApiModal');
  const btnTest = document.getElementById('btnTestApiConnection');
  const btnSave = document.getElementById('btnSaveApiConfig');
  const inputUrl = document.getElementById('inputApiBaseUrl');
  const feedback = document.getElementById('apiTestFeedback');

  inputUrl.value = getApiBaseUrl();

  btnOpen.addEventListener('click', () => {
    inputUrl.value = getApiBaseUrl();
    feedback.innerHTML = '';
    modal.classList.remove('hidden');
  });

  btnClose.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  btnTest.addEventListener('click', async () => {
    const testUrl = inputUrl.value.trim().replace(/\/+$/, '');
    feedback.innerHTML = '<span class="text-info">Testing connection to /api/health...</span>';
    btnTest.disabled = true;

    try {
      const target = testUrl ? `${testUrl}/api/health` : '/api/health';
      const res = await fetch(target);
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        feedback.innerHTML = `<span class="text-success">✓ Connected! Server uptime: ${data.uptimeSeconds}s (SQLite ready)</span>`;
      } else {
        feedback.innerHTML = `<span class="text-warning">⚠ Server responded with status ${res.status}</span>`;
      }
    } catch (err) {
      feedback.innerHTML = `<span class="text-danger">✕ Connection failed: ${err.message}. Check if your Render Web Service is running.</span>`;
    } finally {
      btnTest.disabled = false;
    }
  });

  btnSave.addEventListener('click', () => {
    const newUrl = inputUrl.value.trim().replace(/\/+$/, '');
    if (newUrl) {
      localStorage.setItem('EVENTNEST_API_BASE_URL', newUrl);
      showToast(`Connected to backend: <strong>${newUrl}</strong>`, 'success');
      updateApiStatus(true, 'Render: Connected');
    } else {
      localStorage.removeItem('EVENTNEST_API_BASE_URL');
      showToast('Backend URL cleared. Using default relative API paths.', 'info');
      updateApiStatus(true, 'Backend: Auto');
    }

    modal.classList.add('hidden');
    loadEvents();
  });
}

// --------------------------------------------------------------
// App Initialization
// --------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initPersonaSwitcher();
  initCheckoutActions();
  initEventCreation();
  initConcurrencyLab();
  initDiagnosticsActions();
  initApiConfigModal();

  document.getElementById('btnRefreshEvents').addEventListener('click', loadEvents);

  restoreHoldState();
  loadEvents();

  // Periodic diagnostics refresh if on diagnostics tab
  setInterval(() => {
    if (state.currentTab === 'admin') loadDiagnostics();
  }, 5000);
});
