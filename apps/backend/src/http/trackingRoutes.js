// Public tracking gateway. A link is opened with an unguessable tracking token, which is the only credential. Trip IDs are
// never accepted here. Branch logic is moved from server_production.js. Each matched route answers and returns true at
// once, so the router stops here.

function createTrackingRoutes({ db }) {
  return async function handleTrackingRoute(req, res, { pathname }) {
    if (pathname.startsWith('/t/') || pathname.startsWith('/api/public/tracking/')) {
      const rawToken = pathname.replace('/api/public/tracking/', '').replace('/t/', '').trim();
      const trips = db.getTrips ? db.getTrips() : [];

      // Public tracking requires an unguessable token; trip IDs are never public credentials.
      const trip = trips.find(t => t.trackingToken && t.trackingToken === rawToken);
      if (!trip) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: false, error: 'Tracking link is invalid or expired.' }));
        return true;
      }

      if (pathname.startsWith('/api/public/tracking/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          token: rawToken,
          trip: {
            id: trip.id,
            businessOrderId: trip.businessOrderId || null,
            senderName: trip.senderName,
            goodsDesc: trip.goodsDesc || 'Commercial Goods',
            pickupAddress: trip.pickupAddress,
            dropAddress: trip.dropAddress,
            pickupLat: trip.pickupLat,
            pickupLng: trip.pickupLng,
            dropLat: trip.dropLat,
            dropLng: trip.dropLng,
            driverLat: trip.driver ? trip.driver.currentLat : null,
            driverLng: trip.driver ? trip.driver.currentLng : null,
            driverName: trip.driver ? trip.driver.name : null,
            driverPhone: trip.driver ? trip.driver.phone : null,
            vehicleName: trip.driver ? trip.driver.vehicleName : null,
            vehicleNumber: trip.driver ? trip.driver.vehicleNumber : null,
            status: trip.status,
            etaMinutes: Number.isFinite(trip.etaMinutes) ? trip.etaMinutes : null,
            slaStatus: trip.slaStatus || null,
            podSignature: trip.podSignature || null,
            podPhotos: Array.isArray(trip.podPhotos) ? trip.podPhotos : []
          }
        }));
        return true;
      }

      const appDeepLinkUrl = `vaayu://track/${encodeURIComponent(rawToken)}`;
      const webTrackingUrl = `/public-track.html?token=${encodeURIComponent(rawToken)}`;
      const senderName = String(trip.senderName || 'Delivery').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      const htmlResponse = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#090d16">
  <title>VAAYU Delivery Tracking — ${senderName}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col justify-center items-center p-4">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 text-center space-y-4 shadow-2xl">
    <div class="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center text-3xl mx-auto shadow-lg">
      🚚
    </div>
    <h1 id="trackingHeading" class="text-xl font-black text-white">Opening delivery tracking…</h1>
    <p class="text-xs text-slate-400">Track the live driver map, ETA, route progress and proof of delivery for <b>${senderName}</b>.</p>
    
    <a id="webTrackingLink" href="${webTrackingUrl}" class="block w-full py-3.5 bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 font-black rounded-2xl text-xs uppercase shadow-xl">Open live tracking on the web</a>
    <p id="trackingFallback" class="text-[11px] text-slate-500">If the VAAYU app is installed, it will open automatically. Otherwise, tracking opens here in your browser.</p>
  </div>
  <script>
    (() => {
      const webUrl = ${JSON.stringify(webTrackingUrl)};
      const appUrl = ${JSON.stringify(appDeepLinkUrl)};
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobile) { window.location.replace(webUrl); return; }
      let leftPage = false;
      const fallback = setTimeout(() => { if (!leftPage) window.location.replace(webUrl); }, 1100);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { leftPage = true; clearTimeout(fallback); }
      });
      window.addEventListener('pagehide', () => { leftPage = true; clearTimeout(fallback); }, { once: true });
      window.location.href = appUrl;
    })();
  </script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlResponse);
      return true;
    }

    return false;
  };
}

module.exports = { createTrackingRoutes };
