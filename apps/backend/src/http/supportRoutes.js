// Support ticket creation and the AI customer care chat (with escalation to a human agent). Branch logic is moved from
// server_production.js unchanged. Each matched route answers and returns true at once, so the router stops here.

function createSupportRoutes({ db, enforceSecurityChecks, parseJsonBody, validateFields }) {
  return async function handleSupportRoute(req, res, { pathname }) {
    if (pathname === '/api/support/tickets/create' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'support:create-ticket', requiredRoles: ['CUSTOMER', 'MERCHANT', 'DRIVER'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [data.subject === undefined || (typeof data.subject === 'string' && data.subject.length <= 200), 'subject must be text up to 200 characters'],
          [data.category === undefined || (typeof data.category === 'string' && data.category.length <= 80), 'category must be text up to 80 characters'],
          [data.tripId === undefined || data.tripId === null || (typeof data.tripId === 'string' && data.tripId.length <= 128), 'tripId must be text up to 128 characters'],
        ])) return;
        const ticket = db.createSupportTicket ? db.createSupportTicket({ ...data, customerId: req.user.id, customerName: req.user.name || (req.user.role === 'DRIVER' ? 'Driver' : 'Customer'), customerPhone: req.user.phone }) : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: Boolean(ticket), message: ticket ? 'Support ticket created for review.' : 'Support ticket service is unavailable.', ticket }));
      });
      return true;
    }

    if (pathname === '/api/support/ai-chat' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'support:chat', requiredRoles: ['CUSTOMER', 'MERCHANT', 'DRIVER'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [typeof data.query === 'string' && data.query.trim().length >= 1 && data.query.length <= 1000, 'query is required, up to 1000 characters'],
        ])) return;
        const q = (data.query || '').toLowerCase();
        let reply = '';
        let escalated = false;
        let ticket = null;

        if (q.includes('refund') || q.includes('money back') || q.includes('dispute') || q.includes('return money') || q.includes('cashback') || q.includes('claim')) {
          escalated = true;
          ticket = db.createSupportTicket ? db.createSupportTicket({
            customerId: req.user.id,
            customerName: req.user.name || 'Customer',
            customerPhone: req.user.phone,
            category: 'Human Agent Refund Claim Review',
            subject: data.query || 'Customer requested financial refund adjustment'
          }) : {};
          reply = ticket ? `Refund requests require review by support. Ticket #${ticket.id} has been created for follow-up.` : 'Refund requests require support review. The ticket service is currently unavailable; please try again later.';
        } else if (q.includes('agent') || q.includes('human') || q.includes('talk') || q.includes('person') || q.includes('escalate') || q.includes('representative') || q.includes('speak')) {
          escalated = true;
          ticket = db.createSupportTicket ? db.createSupportTicket({
            customerId: req.user.id,
            customerName: req.user.name || 'Customer',
            customerPhone: req.user.phone,
            category: 'Live Human Support Escalation',
            subject: data.query || 'Customer requested live human agent'
          }) : {};
          reply = ticket ? `A support ticket (#${ticket.id}) has been created for follow-up.` : 'The support ticket service is currently unavailable; please try again later.';
        } else if (q.includes('where') || q.includes('driver') || q.includes('status') || q.includes('tracking') || q.includes('location')) {
          reply = 'For live driver location and delivery status, open the tracking link for your trip.';
        } else if (q.includes('price') || q.includes('fare') || q.includes('cost') || q.includes('rate') || q.includes('helper')) {
          reply = 'Fare depends on the selected vehicle, route, and options. Use the booking fare estimate to see the current quote before confirming.';
        } else if (q.includes('cancel')) {
          reply = '❌ You can cancel your booking directly in the app. Note: All financial refunds for cancelled trips are strictly verified and processed by Human Support Agents to prevent fraud.';
        } else if (q.includes('invoice') || q.includes('gst') || q.includes('bill')) {
          reply = 'Check the completed trip details for any invoice or receipt available for that booking. Contact support if you need billing help.';
        } else {
          reply = '🤖 I am Vaayu AI Assistant! I can help you track your driver, estimate fares, explain cancellation policies, or connect you to a live human agent.';
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          reply,
          escalated,
          ticket
        }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createSupportRoutes };
