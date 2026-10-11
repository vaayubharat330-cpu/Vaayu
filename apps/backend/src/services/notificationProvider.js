const crypto = require('crypto');

class NotificationProvider {
  get url() { return process.env.MESSAGING_PROVIDER_WEBHOOK_URL || ''; }
  get secret() { return process.env.MESSAGING_PROVIDER_WEBHOOK_SECRET || ''; }
  get configured() { return Boolean(this.url && this.secret.length >= 32); }

  async sendCampaign(campaign) {
    // Nothing was sent. The status says so, instead of implying the campaign is still on its way.
    if (!this.configured) return { accepted: false, configured: false, status: 'NOT_CONFIGURED' };
    const target = new URL(this.url);
    if (target.protocol !== 'https:') throw new Error('Messaging provider webhook must use HTTPS.');
    const body = Buffer.from(JSON.stringify({
      event: 'vaayu.broadcast.requested',
      campaignId: campaign.id,
      channel: campaign.channel,
      audience: campaign.targetAudience,
      title: campaign.title,
      message: campaign.messageText,
      promoCode: campaign.promoCode || null
    }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', this.secret).update(`${timestamp}.`).update(body).digest('hex');
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), 'X-Vaayu-Timestamp': timestamp, 'X-Vaayu-Signature': signature, 'Idempotency-Key': campaign.id },
      body,
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Messaging provider returned HTTP ${response.status}.`);
    return { accepted: true, configured: true, status: 'ACCEPTED_BY_PROVIDER' };
  }
}

module.exports = { NotificationProvider, notificationProvider: new NotificationProvider() };
