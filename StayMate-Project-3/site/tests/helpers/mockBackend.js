// Shared test double for Supabase (both the classic-script UMD build used by
// the marketing pages, and the ESM import used by cabinet/index.html) plus
// the Railway backend API. Real network access to these hosts is blocked in
// the CI/sandbox environment, so every E2E test runs against this instead.
//
// State lives in a small in-page object (window.__qaState) so a test can
// flip it (sign in, add a property, etc.) and the mock reacts accordingly.

const DEFAULT_STATE = {
  session: null, // { user: { id, email, created_at } }
  property: null, // { property_id, hotel_name, ... } | null
  rooms: [], // rows from the `rooms` table for the current property
  channels: [], // rows from the `channels` table for the current property
  hotelInfo: null, // row from the `hotel_info` table for the current property
  users: {}, // email -> { password, user }
  signInError: null,
  failNextRequest: null, // url substring to fail once
  requireEmailConfirmation: false, // mirrors Supabase's "Confirm email" toggle
  signInDelayMs: 0, // artificial latency, for testing in-flight/double-submit UI states
};

function buildClientSource() {
  return `
  // Persisted through localStorage (like the real Supabase client persists
  // its session token) so that signOut() + location.reload() — which the
  // app actually does — reflects the logged-out state after reload instead
  // of resetting back to whatever state the test started with.
  function __qaGetState(){
    if (window.__qaState) return window.__qaState;
    try {
      const saved = localStorage.getItem('__qaState');
      window.__qaState = saved ? JSON.parse(saved) : ${JSON.stringify(DEFAULT_STATE)};
    } catch (e) {
      window.__qaState = ${JSON.stringify(DEFAULT_STATE)};
    }
    return window.__qaState;
  }
  // Call after any mutation (session/property/users) — including nested
  // property writes like st.users[email] = ... — so it survives the
  // app's own signOut()+location.reload() the same way a real persisted
  // Supabase session would.
  function __qaPersist(){ try { localStorage.setItem('__qaState', JSON.stringify(window.__qaState)); } catch (e) {} }

  function __qaMakeUser(email){
    return { id: 'u_' + email.replace(/[^a-z0-9]/gi,'_'), email, created_at: new Date().toISOString() };
  }

  function __qaClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: __qaGetState().session } }),
        getUser: async () => ({ data: { user: __qaGetState().session ? __qaGetState().session.user : null } }),
        onAuthStateChange: (cb) => { window.__qaAuthCb = cb; return { data: { subscription: { unsubscribe(){} } } }; },
        signInWithPassword: async ({ email, password }) => {
          const st = __qaGetState();
          if (st.signInDelayMs) await new Promise((r) => setTimeout(r, st.signInDelayMs));
          window.__qaSignInCalls = (window.__qaSignInCalls || 0) + 1;
          if (st.signInError) return { data: {}, error: { message: st.signInError } };
          const rec = st.users[email];
          if (!rec || rec.password !== password) {
            return { data: {}, error: { message: 'Invalid login credentials' } };
          }
          st.session = { user: rec.user };
          __qaPersist();
          return { data: { session: st.session, user: rec.user }, error: null };
        },
        signUp: async ({ email, password }) => {
          const st = __qaGetState();
          if (st.users[email]) {
            const user = st.users[email].user;
            return { data: { user: { ...user, identities: [] } }, error: null };
          }
          const user = __qaMakeUser(email);
          st.users[email] = { password, user };
          if (st.requireEmailConfirmation) {
            __qaPersist();
            return { data: { session: null, user: { ...user, identities: [{ id: '1' }] } }, error: null };
          }
          st.session = { user };
          __qaPersist();
          return { data: { session: st.session, user: { ...user, identities: [{ id: '1' }] } }, error: null };
        },
        signOut: async () => { __qaGetState().session = null; __qaPersist(); return {}; },
        resetPasswordForEmail: async () => ({ error: null }),
        updateUser: async ({ password }) => {
          if (password && password.length < 6) return { error: { message: 'Password should be at least 6 characters' } };
          return { error: null };
        },
      },
      from: (table) => {
        // Thin thenable query-builder stand-in: .eq() ACCUMULATES filters
        // (needed so e.g. rooms.update({...}).eq('id', X).eq('property_id', Y)
        // only touches the one matching row, like real PostgREST/RLS would),
        // every other chain method returns itself, and the chain resolves
        // via .then()/.maybeSingle()/.single() to whatever resolveFn()
        // returns — matching how real supabase-js query builders are
        // themselves thenable (the app frequently awaits a chain directly
        // without a trailing .select()).
        function makeQuery(resolveFn) {
          const filters = {};
          const q = {
            eq: (col, val) => { filters[col] = val; return q; },
            order: () => q,
            select: () => q,
            limit: () => q,
            single: async () => resolveFn(filters),
            maybeSingle: async () => resolveFn(filters),
            then: (resolve, reject) => Promise.resolve(resolveFn(filters)).then(resolve, reject),
          };
          return q;
        }
        function rowMatches(row, filters) {
          return Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
        }

        return {
          select: () => makeQuery((filters) => {
            const st = __qaGetState();
            if (table === 'properties') return { data: st.property, error: null };
            if (table === 'rooms') return { data: (st.rooms || []).filter((r) => rowMatches(r, filters)), error: null };
            if (table === 'channels') return { data: (st.channels || []).filter((r) => rowMatches(r, filters)), error: null };
            if (table === 'hotel_info') return { data: st.hotelInfo || null, error: null };
            return { data: null, error: null };
          }),
          insert: (row) => {
            const doInsert = () => {
              const st = __qaGetState();
              const arr = Array.isArray(row) ? row : [row];
              if (table === 'rooms') {
                const withIds = arr.map((r) => ({ id: 'r_' + Math.random().toString(36).slice(2, 9), amenities: [], ...r }));
                st.rooms = (st.rooms || []).concat(withIds);
                __qaPersist();
                return { data: withIds, error: null };
              }
              if (table === 'properties') {
                st.property = { ...arr[0], subscription_status: 'inactive', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString() };
                __qaPersist();
                return { data: st.property, error: null };
              }
              return { data: arr, error: null };
            };
            return {
              select: () => ({ single: async () => doInsert() }),
              then: (resolve, reject) => Promise.resolve(doInsert()).then(resolve, reject),
            };
          },
          delete: () => makeQuery((filters) => {
            const st = __qaGetState();
            if (table === 'rooms') { st.rooms = (st.rooms || []).filter((r) => !rowMatches(r, filters)); }
            if (table === 'channels') { st.channels = (st.channels || []).filter((r) => !rowMatches(r, filters)); }
            __qaPersist();
            return { error: null };
          }),
          update: (patch) => makeQuery((filters) => {
            const st = __qaGetState();
            if (table === 'properties' && st.property) { Object.assign(st.property, patch); }
            if (table === 'hotel_info') { st.hotelInfo = { ...(st.hotelInfo || {}), ...patch }; }
            if (table === 'rooms') {
              st.rooms = (st.rooms || []).map((r) => (rowMatches(r, filters) ? { ...r, ...patch } : r));
            }
            __qaPersist();
            return { error: null };
          }),
          upsert: (row) => makeQuery(() => {
            const st = __qaGetState();
            if (table === 'channels') {
              st.channels = st.channels || [];
              const idx = st.channels.findIndex((c) => c.channel_type === row.channel_type);
              if (idx >= 0) st.channels[idx] = { ...st.channels[idx], ...row };
              else st.channels.push(row);
              __qaPersist();
            }
            if (table === 'hotel_info') { st.hotelInfo = { ...(st.hotelInfo || {}), ...row }; __qaPersist(); }
            return { error: null };
          }),
        };
      },
      // Mirrors the commit_room_bulk_upload Postgres function (see
      // rooms-bulk-upload-migration.sql): rows with an id update the
      // matching room, rows without one insert a new one.
      rpc: async (fnName, params) => {
        const st = __qaGetState();
        if (fnName === 'commit_room_bulk_upload') {
          const incoming = (params && params.p_rooms) || [];
          for (const r of incoming) {
            if (r.id) {
              st.rooms = (st.rooms || []).map((room) => (String(room.id) === String(r.id) ? { ...room, ...r } : room));
            } else {
              st.rooms = (st.rooms || []).concat([{ id: 'r_' + Math.random().toString(36).slice(2, 9), property_id: params.p_property_id, ...r }]);
            }
          }
          __qaPersist();
          return { data: st.rooms, error: null };
        }
        return { data: null, error: null };
      },
    };
  }

  window.__qaInstallClient = __qaClient;
  `;
}

/**
 * Installs Supabase + Railway API mocks on a page BEFORE navigation.
 * @param {import('@playwright/test').Page} page
 * @param {object} [initialState] partial overrides for DEFAULT_STATE
 */
async function installBackendMock(page, initialState = {}) {
  const state = { ...DEFAULT_STATE, ...initialState };

  await page.addInitScript(
    ({ src, state }) => {
      eval(src); // defines window.__qaInstallClient / __qaGetState
      // Only seed localStorage on the very first navigation of this test
      // (fresh context => empty localStorage); a later reload within the
      // same test — e.g. after the app's own signOut()+reload() — should
      // see whatever the mock persisted, not jump back to the test's
      // original starting state.
      if (!localStorage.getItem('__qaStateSeeded')) {
        localStorage.setItem('__qaState', JSON.stringify(state));
        localStorage.setItem('__qaStateSeeded', '1');
      }
      // Classic UMD global used by marketing pages via supabase-config.js.
      window.supabase = { createClient: () => window.__qaInstallClient() };
    },
    { src: buildClientSource(), state }
  );

  // cabinet/index.html imports supabase-js as an ES module from jsdelivr.
  await page.route('**/supabase-js@2/+esm', (route) => {
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        ${buildClientSource()}
        export function createClient(){ return window.__qaInstallClient(); }
      `,
    });
  });

  // Backend API (Railway). Cover every /api/* route the frontend calls.
  await page.route('**/api/create-subscription-invoice', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invoiceUrl: 'https://secure.wayforpay.com/mock-invoice', orderId: 'SUBMOCK', priceEur: 100 }) })
  );
  await page.route('**/api/create-trial-invoice', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invoiceUrl: 'https://secure.wayforpay.com/mock-trial-invoice', orderId: 'TRLMOCK', priceEur: 100 }) })
  );
  await page.route('**/api/cancel-auto-renew', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, wayforpayConfirmed: false }) })
  );
  await page.route('**/api/notify-signin', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.route('**/api/connect-channel', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.route('**/api/rooms/parse-upload', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'code',
        rooms: [
          { room_type: 'Мок-номер', price_per_night: 1000, capacity: 2, quantity: 1, description: '', amenities: [], uncertain_fields: [], is_duplicate: false },
        ],
      }),
    })
  );

  return state;
}

module.exports = { installBackendMock, DEFAULT_STATE };
