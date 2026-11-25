/* ==========================================================================
   MUZO — core UI logic (Vanilla JS)
   Flow: set Vibe → radar finds same Vibe < 100m → Ping → both tap "We Met"
         → unlock a private 24h Capsule.
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   FIREBASE — placeholder config.
   1. Create a Firebase project and paste your web app config below.
   2. Uncomment initializeApp + the auth/db handles.
   3. Everything below is scaffolded to work without Firebase (mock data).
   --------------------------------------------------------------------------
   const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     projectId: "YOUR_PROJECT",
     storageBucket: "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   firebase.initializeApp(firebaseConfig);
   const auth = firebase.auth();
   const db = firebase.firestore();
-------------------------------------------------------------------------- */
const FIREBASE_READY = false;

/* --------------------------------- Constants -------------------------------- */
const DEFAULT_ORIGIN = { lat: 6.5244, lng: 3.3792 }; // Lagos fallback (demo)
const RADIUS_METERS = 100;
const CAPSULE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EARTH_RADIUS_M = 6371000;
const LOCATION_SYNC_MS = 10000; // how often presence/location is pushed while live

const VIBES = [
  { label: '#Football', emoji: '⚽' },
  { label: '#Coffee', emoji: '☕' },
  { label: '#Code', emoji: '💻' },
  { label: '#Music', emoji: '🎧' },
  { label: '#Travel', emoji: '✈️' },
  { label: '#Startups', emoji: '🚀' }
];

// Three fake people nearby. Offsets are relative to the current user so the
// demo works wherever you are; distances are still computed via Haversine.
const MOCK_USERS = [
  {
    id: 'tunde',
    name: 'Tunde',
    handle: '@tunde.ux',
    vibe: '#Football',
    status: 'Watching match highlights near the terrace',
    offsetMeters: 48,
    bearingDeg: 35,
    color: '#00D4FF'
  },
  {
    id: 'amina',
    name: 'Amina',
    handle: '@amina.builds',
    vibe: '#Coffee',
    status: 'Testing prototypes over an iced espresso',
    offsetMeters: 26,
    bearingDeg: 205,
    color: '#B388FF'
  },
  {
    id: 'chidi',
    name: 'Chidi',
    handle: '@chidi.codes',
    vibe: '#Code',
    status: 'Shipping side projects from the next table',
    offsetMeters: 72,
    bearingDeg: 310,
    color: '#FFB74D'
  }
];

/* ---------------------------------- State ---------------------------------- */
const state = {
  lat: DEFAULT_ORIGIN.lat,
  lng: DEFAULT_ORIGIN.lng,
  locationReady: false,
  isLive: true,
  ghostMode: false,
  locationSyncTimer: null,
  presence: null,
  activeVibe: '#Football',
  users: [],
  pingedUserId: null,
  confirmations: { self: false, peer: false },
  capsulePeer: null,
  capsuleExpiresAt: null,
  countdownTimer: null
};

/* -------------------------------- DOM helpers ------------------------------- */
const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  el(viewId).classList.add('active');
  const scroller = el(viewId).querySelector('.radar-scroll, .capsule-scroll, .onboarding-body');
  if (scroller) scroller.scrollTop = 0;
}

let toastTimer = null;
function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

/* --------------------------- Ghost Mode & presence ---------------------------
   When Ghost Mode is ON:
   • location polling/syncing stops (and geolocation requests are skipped)
   • one final presence write marks us invisible so other radars fade/hide us
   • the main view shows a GHOST pill, banner and radar overlay
   ---------------------------------------------------------------------------- */

/** Publish the presence document other clients read to build their radar. */
function publishPresence() {
  const payload = {
    visible: !state.ghostMode,
    ghost: state.ghostMode,
    lat: state.ghostMode ? null : state.lat,
    lng: state.ghostMode ? null : state.lng,
    vibe: state.activeVibe,
    updatedAt: Date.now()
  };
  state.presence = payload;
  console.log('[MUZO] Presence →', payload);
  console.log('[MUZO] Other radars render you as:', payload.visible ? 'visible' : 'faded / invisible');
  // TODO(Firebase): db.collection('presence').doc(uid).set(payload, { merge: true });
  // Other clients query where('visible', '==', true) and render ghosts faded/absent.
  return payload;
}

function syncLocation() {
  if (state.ghostMode) return; // hard guard: never sync while ghost
  publishPresence();
}

function startLocationSync() {
  if (state.ghostMode || state.locationSyncTimer) return;
  syncLocation();
  state.locationSyncTimer = setInterval(syncLocation, LOCATION_SYNC_MS);
  console.log('[MUZO] Location syncing active');
}

function stopLocationSync() {
  if (state.locationSyncTimer) {
    clearInterval(state.locationSyncTimer);
    state.locationSyncTimer = null;
  }
  console.log('[MUZO] Location syncing paused');
}

/** Single source of truth for the Ghost Mode toggle. */
function setGhostMode(enabled) {
  if (state.ghostMode === enabled) return;
  state.ghostMode = enabled;
  state.isLive = !enabled;

  // 3) Clear visual indicator on the main view
  const radarView = el('radar-view');
  radarView.classList.toggle('ghost-active', enabled);
  const pill = radarView.querySelector('.live-pill');
  pill.classList.toggle('is-ghost', enabled);
  pill.querySelector('.dot-live').classList.toggle('is-ghost', enabled);
  pill.querySelector('[data-live-label]').textContent = enabled ? 'GHOST' : 'LIVE';
  radarView.querySelector('.you-label').textContent = enabled ? 'YOU · GHOST' : 'YOU';

  el('ghost-banner').hidden = !enabled;
  const overlay = el('ghost-overlay');
  overlay.classList.toggle('open', enabled);
  overlay.setAttribute('aria-hidden', String(!enabled));

  const toggle = el('ghost-toggle-btn');
  toggle.classList.toggle('is-on', enabled);
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.title = enabled ? 'Ghost Mode Active — tap to go live' : 'Enable Ghost Mode';

  if (enabled) {
    // 1) Pause all location syncing, then publish the "invisible" state once.
    stopLocationSync();
    publishPresence();
    // 2) Drop any active interaction — a ghost can't be pinged or matched.
    closeMatchModal();
    state.pingedUserId = null;
    console.log('[MUZO] Ghost Mode Active — invisible, location syncing paused');
    showToast('Ghost Mode Active — you’re invisible');
  } else {
    publishPresence(); // visible again
    startLocationSync();
    initGeolocation().then(() => {
      if (!state.ghostMode) buildNearbyUsers();
    });
    console.log('[MUZO] Ghost Mode off — radar live again');
    showToast('You’re live again');
  }
}

/* ------------------------------- Geolocation -------------------------------- */
/**
 * Ask the browser for the user's coordinates. Falls back to a demo origin
 * (and a friendly toast) if permission is denied or the API is unavailable.
 * @returns {Promise<{lat: number, lng: number}>}
 */
function initGeolocation() {
  return new Promise((resolve) => {
    if (state.ghostMode) {
      console.log('[MUZO] Location request skipped — Ghost Mode Active');
      resolve({ lat: state.lat, lng: state.lng });
      return;
    }

    if (!navigator.geolocation) {
      showToast('Geolocation unavailable — using demo location');
      resolve({ ...DEFAULT_ORIGIN });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.lat = position.coords.latitude;
        state.lng = position.coords.longitude;
        state.locationReady = true;
        console.log('[MUZO] Location acquired:', state.lat, state.lng);
        resolve({ lat: state.lat, lng: state.lng });
      },
      (error) => {
        console.warn('[MUZO] Geolocation failed:', error.message);
        state.lat = DEFAULT_ORIGIN.lat;
        state.lng = DEFAULT_ORIGIN.lng;
        showToast('Using demo location — enable location for real proximity');
        resolve({ ...DEFAULT_ORIGIN });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

/** Haversine formula → great-circle distance in whole metres. */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_M * c);
}

/** Project a metre offset + bearing (clockwise from north) into lat/lng. */
function projectCoordinates(originLat, originLng, distanceMeters, bearingDeg) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const bearing = toRad(bearingDeg);
  const latRad = toRad(originLat);
  const dLat = (distanceMeters * Math.cos(bearing)) / EARTH_RADIUS_M;
  const dLng = (distanceMeters * Math.sin(bearing)) / (EARTH_RADIUS_M * Math.cos(latRad));
  return { lat: originLat + toDeg(dLat), lng: originLng + toDeg(dLng) };
}

/** Build nearby users and keep only those inside the 100m radius. */
function buildNearbyUsers() {
  if (state.ghostMode) {
    console.log('[MUZO] Nearby scan skipped — Ghost Mode Active');
    return;
  }

  state.users = MOCK_USERS.map((user) => {
    const coords = projectCoordinates(state.lat, state.lng, user.offsetMeters, user.bearingDeg);
    return {
      ...user,
      lat: coords.lat,
      lng: coords.lng,
      distance: calculateDistance(state.lat, state.lng, coords.lat, coords.lng),
      isMatch: user.vibe === state.activeVibe
    };
  })
    .filter((user) => user.distance <= RADIUS_METERS)
    .sort((a, b) => a.distance - b.distance);

  renderRadarList(state.users);
  renderRadarNodes(state.users);
  updateMatchCount();
  console.log('[MUZO] Nearby users (<100m):', state.users);
}

/* --------------------------------- Rendering -------------------------------- */
/** Render the nearby-user cards, including the Ping buttons. */
function renderRadarList(users) {
  const list = el('radar-list');

  if (!users.length) {
    list.innerHTML = '<p class="radar-footnote">Nobody in range yet. Try changing your vibe.</p>';
    return;
  }

  list.innerHTML = users.map((user) => `
    <article class="user-card glass ${user.isMatch ? 'match-card' : ''}">
      <div class="avatar" style="--node-color: ${escapeHtml(user.color)}">${escapeHtml(user.name[0])}</div>
      <div class="user-info">
        <div class="user-name-row">
          <span class="user-name">${escapeHtml(user.name)}</span>
          <span class="user-handle">${escapeHtml(user.handle)}</span>
        </div>
        <span class="user-status">${escapeHtml(user.status)}</span>
        <div class="user-meta">
          <span class="vibe-chip ${user.isMatch ? 'chip-accent' : ''}">${escapeHtml(user.vibe)}</span>
          <span class="distance-badge">~${user.distance}m</span>
        </div>
      </div>
      <button class="ping-btn" type="button" data-ping="${escapeHtml(user.id)}">Ping</button>
    </article>
  `).join('');
}

/** Place pulsing dots on the radar based on bearing + distance. */
function renderRadarNodes(users) {
  const scope = el('radar-scope');
  scope.querySelectorAll('.radar-node').forEach((node) => node.remove());

  users.forEach((user) => {
    const bearing = (user.bearingDeg * Math.PI) / 180;
    const fraction = Math.min(user.distance / RADIUS_METERS, 0.92);
    const x = 50 + Math.sin(bearing) * fraction * 42;
    const y = 50 - Math.cos(bearing) * fraction * 42;

    const node = document.createElement('div');
    node.className = `radar-node ${user.isMatch ? 'match' : ''}`;
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    node.style.setProperty('--node-color', user.color);
    node.innerHTML = `
      <div class="node-avatar">${escapeHtml(user.name[0])}</div>
      <span class="node-distance">~${user.distance}m</span>
    `;
    scope.appendChild(node);
  });
}

function updateMatchCount() {
  const matches = state.users.filter((user) => user.isMatch).length;
  el('match-count').textContent = String(matches);
  el('active-vibe-chip').textContent = state.activeVibe;
}

function renderVibeOptions() {
  el('vibe-options').innerHTML = VIBES.map((vibe) => `
    <button class="vibe-option ${vibe.label === state.activeVibe ? 'selected' : ''}"
            type="button" data-vibe="${escapeHtml(vibe.label)}" aria-pressed="${vibe.label === state.activeVibe}">
      <span class="vibe-emoji" aria-hidden="true">${vibe.emoji}</span>
      <span>${escapeHtml(vibe.label)}</span>
    </button>
  `).join('');
}

/* ---------------------------------- Actions --------------------------------- */
function handleVibeSelect(vibe) {
  state.activeVibe = vibe;
  renderVibeOptions();
  console.log('[MUZO] Active vibe:', vibe);
}

async function handleGoLive() {
  if (state.ghostMode) {
    setGhostMode(false);
    showView('radar-view');
    return;
  }

  const button = el('go-live-btn');
  button.disabled = true;
  button.querySelector('.btn-label').textContent = 'Locating you…';
  el('location-status').querySelector('span').textContent = 'Requesting location permission…';

  await initGeolocation();
  buildNearbyUsers();

  button.disabled = false;
  button.querySelector('.btn-label').textContent = 'Go live on the radar';
  el('location-status').querySelector('span').textContent = state.locationReady
    ? 'Location active · visible within 100m'
    : 'Using demo location · enable GPS for real proximity';

  showView('radar-view');
  startLocationSync();
  showToast(`Radar live · ${state.users.length} people nearby`);
  console.log('[MUZO] Radar live with vibe', state.activeVibe);
}

/** Ping handler: logs for now; opens the demo "We Met" modal. */
function handlePing(userId) {
  if (state.ghostMode) {
    showToast('Turn off Ghost Mode to Ping');
    return;
  }

  const user = state.users.find((u) => u.id === userId);
  if (!user) return;

  console.log('[MUZO] PING →', user.name, `(${(user.distance)}m, ${user.vibe})`);
  // TODO(Firebase): db.collection('pings').add({ from: uid, to: user.id, vibe, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

  const button = document.querySelector(`[data-ping="${user.id}"]`);
  if (button) { button.textContent = 'Pinged'; button.disabled = true; }

  openMatchModal(user);
}

function openMatchModal(user) {
  state.pingedUserId = user.id;
  state.capsulePeer = user;
  state.confirmations = { self: false, peer: false };

  el('match-avatar').textContent = user.name[0];
  el('match-avatar').style.setProperty('--node-color', user.color);
  el('match-name').textContent = user.name;
  el('match-handle').textContent = user.handle;
  el('match-vibe').textContent = user.vibe;
  el('match-distance').textContent = `~${user.distance}m`;
  el('confirm-peer-name').textContent = user.name;

  ['self', 'peer'].forEach((side) => {
    el(`confirm-${side}-btn`).classList.remove('confirmed');
  });
  el('unlock-capsule-btn').disabled = true;

  el('match-modal').classList.add('open');
  el('match-modal').setAttribute('aria-hidden', 'false');
}

function closeMatchModal() {
  el('match-modal').classList.remove('open');
  el('match-modal').setAttribute('aria-hidden', 'true');
}

/** Both people must tap "We Met" before the capsule unlocks. */
function handleWeMet(side) {
  if (!state.pingedUserId) return;

  state.confirmations[side] = true;
  el(`confirm-${side}-btn`).classList.add('confirmed');
  console.log('[MUZO] We Met confirmed by:', side);

  if (state.confirmations.self && state.confirmations.peer) {
    el('unlock-capsule-btn').disabled = false;
    showToast('Both taps in — capsule ready!');
  }
}

function unlockCapsule() {
  if (!state.capsulePeer) return;
  const peer = state.capsulePeer;

  state.capsuleExpiresAt = Date.now() + CAPSULE_TTL_MS;
  closeMatchModal();

  el('capsule-peer-name').textContent = peer.name;
  el('capsule-vibe').textContent = peer.vibe;
  el('capsule-distance').textContent = `~${peer.distance}m apart`;
  el('capsule-moment').textContent = `You and ${peer.name} verified a real-world meetup through ${peer.vibe}.`;

  console.log('[MUZO] Capsule unlocked for', peer.name, 'expires', new Date(state.capsuleExpiresAt));
  // TODO(Firebase): db.collection('capsules').add({ members: [uid, peer.id], vibe, expiresAt, ... });

  showView('capsule-view');
  startCapsuleCountdown();
  showToast('Private capsule unlocked ✦');
}

function startCapsuleCountdown() {
  clearInterval(state.countdownTimer);

  const tick = () => {
    const remaining = Math.max(0, state.capsuleExpiresAt - Date.now());
    if (remaining === 0) {
      clearInterval(state.countdownTimer);
      el('capsule-countdown').textContent = '00:00:00';
      showToast('Capsule expired');
      return;
    }

    const totalSeconds = Math.floor(remaining / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    el('capsule-countdown').textContent = `${hours}:${minutes}:${seconds}`;
  };

  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

/* ------------------------------- Event wiring ------------------------------- */
function initEventListeners() {
  // Vibe chips (delegated)
  el('vibe-options').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-vibe]');
    if (chip) handleVibeSelect(chip.dataset.vibe);
  });

  el('go-live-btn').addEventListener('click', handleGoLive);

  // Ghost Mode toggle + both "Go Live Again" controls
  el('ghost-toggle-btn').addEventListener('click', () => setGhostMode(!state.ghostMode));
  document.querySelectorAll('[data-resume-live]').forEach((button) => {
    button.addEventListener('click', () => setGhostMode(false));
  });

  el('edit-vibe-btn').addEventListener('click', () => {
    showView('onboarding-view');
    document.querySelector('[data-onboarding-kicker]').textContent = 'UPDATE YOUR RADAR VIBE';
  });

  // Ping buttons (delegated) — log to console for now
  el('radar-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ping]');
    if (button && !button.disabled) handlePing(button.dataset.ping);
  });

  document.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeMatchModal);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMatchModal();
  });

  document.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', () => handleWeMet(button.dataset.confirm));
  });
  el('unlock-capsule-btn').addEventListener('click', unlockCapsule);
  el('capsule-back-btn').addEventListener('click', () => {
    clearInterval(state.countdownTimer);
    showView('radar-view');
  });

  document.querySelector('[data-add-moment]').addEventListener('click', () => {
    console.log('[MUZO] Add moment (Firestore upload goes here)');
    showToast('Moment composer coming soon');
  });
}

/* ---------------------------------- Bootstrap -------------------------------- */
function initApp() {
  renderVibeOptions();
  initEventListeners();
  buildNearbyUsers(); // pre-render mock data with the default origin
  console.log('[MUZO] Ready. Firebase connected:', FIREBASE_READY);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
