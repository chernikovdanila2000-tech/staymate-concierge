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
        start() {
          this.started = true;
          if (speech === 'refuse') setTimeout(() => this.onerror && this.onerror({ error: 'service-not-allowed' }), 0);
        }
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

  test('mic: dictated text appears in the input WHILE speaking, in the chosen language, and is not sent until the user sends it', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'live' }), { speech: 'live' });
    await page.addInitScript(() => { try { localStorage.setItem('stayai_voice_lang', 'uk'); } catch (e) {} });
    const calls = await routeOnboarding(page);

    await page.goto('/onboard.html');
    await expect(page.locator('#obLang')).toHaveText('УКР');
    await page.click('#obLang');
    await expect(page.locator('#obLang')).toHaveText('РУС');

    await page.fill('#obInput', 'Привет.');
    await page.click('#obMic');
    await expect(page.locator('#obMic')).toHaveClass(/rec/);
    await expect(page.locator('#obLang')).toBeDisabled();
    expect(await page.evaluate(() => window.__qaSpeech.lang)).toBe('ru-RU');

    // Interim words show up immediately, then get replaced by the final text.
    await page.evaluate(() => window.__qaSpeak([['у меня сто', false]]));
    await expect(page.locator('#obInput')).toHaveValue('Привет. у меня сто');
    await page.evaluate(() => window.__qaSpeak([['У меня СТО,', true], [' двадцать машин', false]]));
    await expect(page.locator('#obInput')).toHaveValue('Привет. У меня СТО, двадцать машин');

    await page.click('#obMic');
    await expect(page.locator('#obMic')).not.toHaveClass(/rec/);
    await expect(page.locator('#obInput')).toHaveValue('Привет. У меня СТО, двадцать машин');
    expect(calls.chat).toBe(0);
    expect(calls.voice).toHaveLength(0);
    await expect(page.locator('.ob-msg.user')).toHaveCount(0);

    await page.click('#obSend');
    await expect(page.locator('.ob-msg.user')).toContainText('У меня СТО, двадцать машин');
    expect(calls.chat).toBe(1);
  });

  test('mic without browser speech recognition (e.g. Firefox): records, server transcribes with the chosen language, text lands in the input unsent', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'none' }), { speech: 'none' });
    await page.addInitScript(() => { try { localStorage.setItem('stayai_voice_lang', 'ru'); } catch (e) {} });
    const calls = await routeOnboarding(page);

    await page.goto('/onboard.html');
    await page.fill('#obInput', 'Привіт.');
    await page.click('#obMic');
    await expect(page.locator('#obMic')).toHaveClass(/rec/);
    await page.click('#obMic');

    await expect(page.locator('#obInput')).toHaveValue('Привіт. В мене СТО, 20 машин на день');
    expect(calls.voice).toHaveLength(1);
    expect(calls.voice[0]).toContain('name="language"');
    expect(calls.voice[0]).toMatch(/name="language"\r\n\r\nru\r\n/);
    expect(calls.chat).toBe(0);
  });

  test('mic falls back to server transcription when the browser refuses its own speech service', async ({ page }) => {
    await page.addInitScript(fakeRecorderScript({ speech: 'refuse' }), { speech: 'refuse' });
    const calls = await routeOnboarding(page);

    await page.goto('/onboard.html');
    await page.click('#obMic');
    // The refusal switches to plain recording, still visibly recording.
    await expect(page.locator('#obMic')).toHaveClass(/rec/);
    await page.click('#obMic');
    await expect(page.locator('#obInput')).toHaveValue('В мене СТО, 20 машин на день');
    expect(calls.voice).toHaveLength(1);
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
