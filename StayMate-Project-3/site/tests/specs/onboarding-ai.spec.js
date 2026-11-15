const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test.describe('AI onboarding — onboard.html chat', () => {
  test('shows a price card when the AI proposes one, and lets the owner accept it', async ({ page }) => {
    await page.route('**/api/onboarding-chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: 'Дякую! Ось моя пропозиція:',
          profile: { business_name: 'Кавʼярня "Дім"' },
          priceProposal: { priceUah: 4999, justification: 'Малий потік клієнтів.' },
        }),
      })
    );

    await page.goto('/onboard.html');
    await page.fill('#obInput', 'У мене маленька кавʼярня');
    await page.click('#obSend');

    await expect(page.locator('.ob-price-card .amount')).toContainText('4 999');
    await expect(page.locator('.ob-price-card .why')).toContainText('Малий потік клієнтів.');

    await page.click('.ob-btn-accept');
    await page.waitForURL(/cabinet\/\?ob=/);
  });

  // Headless Chromium has no microphone: stand in for getUserMedia and
  // MediaRecorder so the page's own record/stop/upload flow runs as-is.
  function fakeRecorderScript({ speech }) {
    return ({ speech }) => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      });
      window.MediaRecorder = class {
        constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.listeners = {}; }
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          (this.listeners.dataavailable || []).forEach((fn) => fn({ data: new Blob(['voice'], { type: 'audio/webm' }) }));
          (this.listeners.stop || []).forEach((fn) => fn());
        }
      };
      if (speech === 'none') {
        delete window.SpeechRecognition;
        delete window.webkitSpeechRecognition;
        return;
      }
      // Fake browser speech recognition the test drives via window.__qaSpeak.
      class FakeSpeech {
        constructor() { window.__qaSpeech = this; this.started = false; }
        start() { this.started = true; }
        stop() { this.started = false; setTimeout(() => this.onend && this.onend(), 0); }
      }
      window.SpeechRecognition = FakeSpeech;
      window.webkitSpeechRecognition = FakeSpeech;
      // results: [[text, isFinal], ...] — the full result list, like the real API.
      window.__qaSpeak = (results, resultIndex = 0) => {
        const list = results.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
        window.__qaSpeech.onresult({ resultIndex, results: list });
      };
    };
  }

  async function routeOnboarding(page) {
    const calls = { chat: 0, voice: [] };
    await page.route('**/api/onboarding-chat', (route) => {
      calls.chat += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'ok', profile: {} }) });
    });
    await page.route('**/api/onboarding-voice', (route) => {
      calls.voice.push(route.request().postData() || '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'В мене СТО, 20 машин на день' }) });
    });
    return calls;
  }

  test('mic: a live draft appears WHILE speaking, then the server text (language auto-detected) replaces it; nothing is sent until the user sends it', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'live' }), { speech: 'live' });
    const calls = await routeOnboarding(page);

    await page.goto('/onboard.html');
    await expect(page.locator('#obLang')).toHaveCount(0);
    await page.fill('#obInput', 'Привіт.');
    await page.click('#obMic');
    await expect(page.locator('#obMic')).toHaveClass(/rec/);

    // Draft words show up immediately while speaking.
    await page.evaluate(() => window.__qaSpeak([['у мене сто', false]]));
    await expect(page.locator('#obInput')).toHaveValue('Привіт. у мене сто');
    await page.evaluate(() => window.__qaSpeak([['у мене СТО,', true], [' двадцять', false]]));
    await expect(page.locator('#obInput')).toHaveValue('Привіт. у мене СТО, двадцять');

    await page.click('#obMic');
    await expect(page.locator('#obMic')).not.toHaveClass(/rec/);
    // The accurate server text replaces the draft (typed text kept).
    await expect(page.locator('#obInput')).toHaveValue('Привіт. В мене СТО, 20 машин на день');
    expect(calls.voice).toHaveLength(1);
    // No language is forced — the server detects it from the recording.
    expect(calls.voice[0]).not.toContain('name="language"');
    expect(calls.chat).toBe(0);
    await expect(page.locator('.ob-msg.user')).toHaveCount(0);

    await page.click('#obSend');
    await expect(page.locator('.ob-msg.user')).toContainText('В мене СТО, 20 машин на день');
    expect(calls.chat).toBe(1);
  });

  test('mic without browser speech recognition (e.g. Firefox): no draft, but the server text still lands in the input unsent', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'none' }), { speech: 'none' });
    const calls = await routeOnboarding(page);

    await page.goto('/onboard.html');
    await page.click('#obMic');
    await expect(page.locator('#obMic')).toHaveClass(/rec/);
    await page.click('#obMic');

    await expect(page.locator('#obInput')).toHaveValue('В мене СТО, 20 машин на день');
    expect(calls.voice).toHaveLength(1);
    expect(calls.chat).toBe(0);
  });

  test('mic: when the browser stops its recognizer after a pause (Safari), the draft keeps going and keeps earlier words', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'live' }), { speech: 'live' });
    await routeOnboarding(page);

    await page.goto('/onboard.html');
    await page.click('#obMic');
    await page.evaluate(() => window.__qaSpeak([['у мене СТО', true]]));
    const first = await page.evaluate(() => window.__qaSpeech);
    // The browser ends the session on its own while we're still recording.
    await page.evaluate(() => window.__qaSpeech.onend());
    await expect.poll(() => page.evaluate(() => window.__qaSpeech.started)).toBe(true);
    expect(await page.evaluate((f) => window.__qaSpeech !== f, first)).toBe(true);
    await page.evaluate(() => window.__qaSpeak([['двадцять машин', false]]));
    await expect(page.locator('#obInput')).toHaveValue('у мене СТО двадцять машин');
  });

  test('mic: if the server transcription fails, the live draft is kept instead of being lost', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'live' }), { speech: 'live' });
    await page.route('**/api/onboarding-voice', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Сервис распознавания не смог обработать голосовое сообщение.' }) })
    );

    await page.goto('/onboard.html');
    await page.click('#obMic');
    await page.evaluate(() => window.__qaSpeak([['у мене СТО', true]]));
    await page.click('#obMic');

    await expect(page.locator('#obMic')).not.toHaveClass(/rec/);
    await expect(page.locator('#obInput')).toHaveValue('у мене СТО');
    await expect(page.locator('#obInput')).toBeEnabled();
    await expect(page.locator('.ob-msg.ai', { hasText: 'Сервис распознавания' })).toHaveCount(0);
  });

  test('declining a price card dismisses it and lets the conversation continue', async ({ page }) => {
    await page.route('**/api/onboarding-chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: 'Ось моя пропозиція:',
          profile: {},
          priceProposal: { priceUah: 9999, justification: 'Середній потік.' },
        }),
      })
    );

    await page.goto('/onboard.html');
    await page.fill('#obInput', 'Готель на 20 номерів');
    await page.click('#obSend');
    await expect(page.locator('.ob-price-card')).toBeVisible();

    await page.click('.ob-btn-decline');
    await expect(page.locator('.ob-price-card')).toHaveCount(0);
  });
});

test.describe('AI onboarding — cabinet confirmation screen', () => {
  test('a visitor arriving with an accepted AI quote skips the manual form and goes straight to the custom-price confirmation', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'owner@example.com', created_at: new Date().toISOString() } },
      property: null,
      onboardingProfile: {
        business_name: 'Кавʼярня "Дім"',
        business_type: 'кавʼярня',
        description: 'Невелика кавʼярня в центрі',
        proposedPriceUah: 4999,
        priceJustification: 'Малий потік клієнтів, 1-2 канали.',
      },
    });
    // A real wayforpay response would commit the redirect and tear down
    // this page's JS context (__qaState included) before the assertions
    // below can read it, so this override (takes priority over
    // installBackendMock's own route, registered after it) holds the
    // response just long enough to read state while the fetch is still
    // in flight, before the handler's window.location.href ever runs.
    let invoiceRequestBody = null;
    await page.route('**/api/create-subscription-invoice', async (route) => {
      invoiceRequestBody = JSON.parse(route.request().postData() || '{}');
      await new Promise((r) => setTimeout(r, 300));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invoiceUrl: 'https://secure.wayforpay.com/mock-invoice', orderId: 'SUBMOCK', priceUah: invoiceRequestBody.customPriceUah }) });
    });

    await page.goto('/cabinet/?ob=sess-123');

    await expect(page.locator('#obAiScreen')).toBeVisible();
    await expect(page.locator('#onboardScreen')).toBeHidden();
    await expect(page.locator('#obAiBusinessName')).toHaveText('Кавʼярня "Дім"');
    await expect(page.locator('#obAiPrice')).toContainText('4 999');
    await expect(page.locator('#obAiJustification')).toContainText('Малий потік клієнтів');

    await page.click('#obAiConfirmBtn');
    // The property insert happens before the (deliberately slowed-down)
    // invoice fetch, so by the time that request lands, __qaState.property
    // is already set and still readable.
    await page.waitForFunction(() => window.__qaState.property !== null);
    const property = await page.evaluate(() => window.__qaState.property);

    expect(property.business_type).toBe('кавʼярня');
    expect(property.hotel_name).toBe('Кавʼярня "Дім"');
    await expect.poll(() => invoiceRequestBody).not.toBeNull();
    expect(invoiceRequestBody.plan).toBe('custom');
    expect(invoiceRequestBody.customPriceUah).toBe(4999);
  });

  test('an expired or missing onboarding session falls back to the normal manual onboarding form, not a dead end', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'owner@example.com', created_at: new Date().toISOString() } },
      property: null,
      onboardingProfile: null, // expired/never existed -> GET /api/onboarding-profile/* returns 404
    });

    await page.goto('/cabinet/?ob=expired-session');

    await expect(page.locator('#onboardScreen')).toBeVisible();
    await expect(page.locator('#obAiScreen')).toBeHidden();
  });
});
