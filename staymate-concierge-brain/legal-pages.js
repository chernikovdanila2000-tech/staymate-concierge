'use strict';

const UPDATED = '14 September 2026';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function page(title, intro, sections) {
  const content = sections.map(([heading, paragraphs]) => `
    <section><h2>${escapeHtml(heading)}</h2>${paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('')}</section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} | Staynix</title>
<style>body{margin:0;background:#f6f7fb;color:#172033;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:780px;margin:48px auto;padding:40px;background:#fff;border-radius:20px;box-shadow:0 10px 35px #15213a14}h1{font-size:2rem;margin:0 0 8px}h2{font-size:1.2rem;margin:30px 0 6px}p{margin:8px 0}.muted{color:#667085}a{color:#3457d5}@media(max-width:700px){main{margin:0;padding:28px 20px;border-radius:0}}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p class="muted">Last updated: ${UPDATED}</p><p>${escapeHtml(intro)}</p>${content}<p class="muted">Questions or requests can be sent to the Staynix Facebook Page through Messenger.</p></main></body></html>`;
}

const pages = {
  '/privacy': page('Privacy Policy', 'Staynix provides automated guest-messaging services for hospitality businesses.', [
    ['Information we process', ['We process messages and basic Messenger identifiers that users choose to send to a connected hospitality business. We may also process reservation or service details supplied in the conversation.']],
    ['How we use information', ['Information is used only to answer guest questions, provide requested hospitality services, maintain conversation context, prevent abuse, and operate and improve the service.']],
    ['Sharing and retention', ['We share information only with the connected hospitality business and service providers needed to operate Staynix. We do not sell personal information. Data is retained only as long as needed for the service, security, and applicable legal obligations.']],
    ['Security and user rights', ['We use access controls, encrypted transport, and verified webhook signatures. Users may ask to access, correct, or delete their conversation data through the Staynix Facebook Page.']],
  ]),
  '/terms': page('Terms of Service', 'These terms govern use of the Staynix automated guest-messaging service.', [
    ['Service', ['Staynix helps hospitality businesses answer guest questions and handle service requests. Automated answers may be incomplete, and users should confirm important reservation, safety, payment, or emergency information with the hospitality business.']],
    ['Acceptable use', ['Users must not misuse the service, attempt unauthorized access, send unlawful content, or interfere with its operation.']],
    ['Availability and liability', ['The service is provided on an as-available basis. To the extent permitted by law, Staynix is not liable for indirect losses or decisions made solely from automated responses.']],
    ['Changes and termination', ['We may update these terms or suspend access when required for security, legal compliance, or misuse prevention. Continued use after an update means acceptance of the revised terms.']],
  ]),
  '/data-deletion': page('Data Deletion Instructions', 'You can request deletion of data associated with your Messenger conversation.', [
    ['How to request deletion', ['Open the Staynix Facebook Page in Messenger and send a message containing “Delete my data”. Include no additional sensitive information. A page administrator will verify and process the request.']],
    ['What will be deleted', ['Conversation history and the Messenger-scoped identifier held by Staynix will be removed, except records that must be retained for security, fraud prevention, or legal obligations.']],
    ['Timing', ['Verified deletion requests are normally completed within 30 days. The connected hospitality business may separately hold reservation records under its own legal obligations.']],
  ]),
};

function serveLegalPage(pathname, res) {
  const html = pages[pathname];
  if (!html) return false;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
  return true;
}

module.exports = { serveLegalPage };
