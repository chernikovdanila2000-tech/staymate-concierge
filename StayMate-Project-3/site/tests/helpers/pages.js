// Central list of pages so every spec iterates the same inventory instead
// of hardcoding it in six different files.

const MARKETING_PAGES = [
  'index.html',
  'features.html',
  'how-it-works.html',
  'pricing.html',
  'instructions.html',
  'contacts.html',
];

// Pages that just redirect (no point testing them for content/i18n).
const REDIRECT_STUBS = ['login.html', 'register.html', 'account.html', 'connect.html'];

const ALL_SITE_PAGES = [...MARKETING_PAGES, ...REDIRECT_STUBS, 'checkout.html'];

const LANGS = ['uk', 'en'];

module.exports = { MARKETING_PAGES, REDIRECT_STUBS, ALL_SITE_PAGES, LANGS };
