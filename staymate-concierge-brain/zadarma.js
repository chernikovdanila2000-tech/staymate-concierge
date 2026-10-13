'use strict';

/** Provider-only configuration; the AI/tenant logic deliberately does not live here. */
class ZadarmaProvider {
  constructor({ openaiProjectId }) { this.openaiProjectId = openaiProjectId; }
  inboundSipUri() {
    if (!this.openaiProjectId) throw new Error('VOICE_OPENAI_PROJECT_ID is required for Zadarma SIP routing');
    return `sip:${this.openaiProjectId}@sip.api.openai.com;transport=tls`;
  }
  routingInstructions() {
    return 'Route the verified Zadarma virtual number to the returned external SIP URI. Do not place SIP credentials in source control.';
  }
}
module.exports = { ZadarmaProvider };
