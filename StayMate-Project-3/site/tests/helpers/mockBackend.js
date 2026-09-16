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
      from: (table) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              const st = __qaGetState();
              if (table === 'properties') return { data: st.property, error: null };
              return { data: null, error: null };
            },
            order: () => ({ then: (r) => r([]) , maybeSingle: async () => ({data:null,error:null}) }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              const st = __qaGetState();
              const prop = Array.isArray(row) ? row[0] : row;
              st.property = { ...prop, subscription_status: 'inactive', trial_ends_at: new Date(Date.now()+3*86400000).toISOString() };
              __qaPersist();
              return { data: st.property, error: null };
            },
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
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

  return state;
}

module.exports = { installBackendMock, DEFAULT_STATE };
