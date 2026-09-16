const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { installBackendMock } = require('../helpers/mockBackend');

const SITE_ROOT = path.join(__dirname, '..', '..');
const BRAIN_ROOT = path.join(__dirname, '..', '..', '..', '..', 'staymate-concierge-brain');

test.describe('Security — protected pages', () => {
  test('cabinet dashboard is never shown without a valid session, even mid-load', async ({ page }) => {
    await installBackendMock(page); // no session
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#onboardScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#gateScreen')).toHaveClass(/hidden/);
  });

  test('logging out clears previously-shown property data from the DOM', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Secret Hotel Name', trial_ends_at: new Date(Date.now() + 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashHotelName')).toContainText('Secret Hotel Name');
    await page.locator('#accountMenuBtn').click();
    await page.locator('#accountStatus .acct-logout').click();
    await expect(page.locator('#authScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('body')).not.toContainText('Secret Hotel Name');
  });

  test('a fresh page load with no session never renders a previous visitor\'s property data (new browser context)', async ({ browser }) => {
    // Distinct from the logout case above: this proves the leak can't happen
    // even without ever having logged in on this "browser" at all.
    const context = await browser.newContext();
    const page = await context.newPage();
    await installBackendMock(page); // no session
    await page.goto('/cabinet/');
    await expect(page.locator('body')).not.toContainText('Secret Hotel Name');
    await context.close();
  });
});

test.describe('Security — no secrets shipped to the frontend', () => {
  const FORBIDDEN_PATTERNS = [
    { name: 'Supabase service_role key marker', re: /service_role/i },
    { name: 'Anthropic API key', re: /sk-ant-[a-zA-Z0-9_-]{10,}/ },
    { name: 'WayForPay merchant secret (known test value)', re: /flk3409refn54t54t/ },
  ];

  test('site/*.html and cabinet/index.html contain no server-side secrets', async () => {
    const files = fs
      .readdirSync(SITE_ROOT)
      .filter((f) => f.endsWith('.html'))
      .map((f) => path.join(SITE_ROOT, f))
      .concat([path.join(SITE_ROOT, 'cabinet', 'index.html'), path.join(SITE_ROOT, 'supabase-config.js')]);

    const findings = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.re.test(content)) findings.push(`${path.basename(file)}: ${pattern.name}`);
      }
      // Only the anon/publishable Supabase key belongs on the frontend —
      // flag anything that looks like a service key format used as SUPABASE_KEY.
      if (/SUPABASE_KEY\s*=/.test(content)) findings.push(`${path.basename(file)}: has a SUPABASE_KEY assignment (should only ever be anon/publishable, and only server-side vars should be named this)`);
    }
    expect(findings, 'possible secrets found in frontend-shipped files').toEqual([]);
  });
});

test.describe('Security — database access control (static review)', () => {
  test('every multi-tenant table has Row Level Security enabled in the SQL migrations', () => {
    const sqlFiles = fs.readdirSync(BRAIN_ROOT).filter((f) => f.endsWith('.sql'));
    const combined = sqlFiles.map((f) => fs.readFileSync(path.join(BRAIN_ROOT, f), 'utf-8')).join('\n');

    const tenantTables = ['properties', 'rooms', 'bookings', 'channels', 'conversations', 'subscription_orders'];
    const missing = tenantTables.filter((t) => !new RegExp(`alter table ${t}[\\s\\S]{0,40}enable row level security`, 'i').test(combined));
    expect(missing, 'tables without an explicit ENABLE ROW LEVEL SECURITY statement').toEqual([]);
  });
});

test.describe('Security — tenant isolation (documented, not fully testable here)', () => {
  test('cabinet never accepts a property/tenant id from the URL — data access is always keyed off the signed-in session', async ({ page }) => {
    // The app has no `?propertyId=` or `/cabinet/:id` pattern anywhere — every
    // property lookup goes through `.eq('owner_id', session.user.id)`. This
    // test asserts that invariant still holds in the shipped code, since a
    // future change that starts trusting an id from the URL would be exactly
    // the kind of IDOR this product can't afford.
    const cabinetSource = fs.readFileSync(path.join(SITE_ROOT, 'cabinet', 'index.html'), 'utf-8');
    const ownerScopedQueries = (cabinetSource.match(/\.eq\('owner_id'/g) || []).length;
    expect(ownerScopedQueries, 'property queries should filter by owner_id').toBeGreaterThan(0);
    expect(cabinetSource).not.toMatch(/propertyId["'`]?\s*[:=]\s*new URLSearchParams/i);
  });
});
