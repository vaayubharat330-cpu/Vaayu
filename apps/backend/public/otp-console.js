(() => {
  let token = null;
  let timer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS_STYLE = {
    PENDING: 'text-amber-300',
    VERIFIED: 'text-emerald-300',
    EXPIRED: 'text-slate-400',
    LOCKED: 'text-rose-300',
    INVALIDATED: 'text-slate-500',
  };

  function formatTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
  }

  function showSignedIn(name) {
    $('loginPanel').classList.add('hidden');
    $('console').classList.remove('hidden');
    $('session').classList.remove('hidden');
    $('session').classList.add('flex');
    $('adminName').textContent = name;
  }

  function showSignedOut() {
    token = null;
    clearInterval(timer);
    $('loginPanel').classList.remove('hidden');
    $('console').classList.add('hidden');
    $('session').classList.add('hidden');
    $('session').classList.remove('flex');
    $('password').value = '';
  }

  function renderBanner(mode) {
    const banner = $('modeBanner');
    if (mode === 'CONSOLE') {
      banner.className = 'mb-4 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200';
      banner.textContent = 'Test mode: no SMS provider is connected. Codes are shown here so you can sign in to the portals. Turn this off by connecting OTP_DELIVERY_WEBHOOK_URL.';
    } else if (mode === 'WEBHOOK') {
      banner.className = 'mb-4 rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200';
      banner.textContent = 'SMS delivery is live through the configured provider. Codes are sent to users\u2019 phones and are not shown here.';
    } else {
      banner.className = 'mb-4 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200';
      banner.textContent = 'OTP delivery is not configured. Login codes cannot be sent until an SMS provider or the test mode is enabled.';
    }
  }

  function renderRows(requests) {
    $('empty').classList.toggle('hidden', requests.length > 0);
    $('rows').innerHTML = requests.map((r) => {
      const code = r.code
        ? `<span class="font-mono text-lg font-bold text-emerald-300 tracking-widest">${esc(r.code)}</span>`
        : '<span class="text-slate-600">hidden</span>';
      const delivery = r.deliveryStatus === 'FAILED'
        ? `<span class="text-rose-300" title="${esc(r.deliveryError || '')}">Failed</span>`
        : esc(r.deliveryStatus === 'CONSOLE' ? 'Test mode' : r.deliveryStatus === 'SENT' ? 'Sent' : r.deliveryStatus);
      const signedIn = r.signedInRole ? ` <span class="text-xs text-slate-500">(${esc(r.signedInRole)})</span>` : '';
      return `<tr class="border-b border-slate-800/60">
        <td class="px-3 py-2 whitespace-nowrap">${esc(formatTime(r.createdAt))}</td>
        <td class="px-3 py-2">${esc(r.app)}${signedIn}</td>
        <td class="px-3 py-2 font-mono">${esc(r.maskedPhone)}</td>
        <td class="px-3 py-2 ${STATUS_STYLE[r.status] || ''}">${esc(r.status)}</td>
        <td class="px-3 py-2">${esc(r.attempts)} / ${esc(r.maxAttempts)}</td>
        <td class="px-3 py-2">${delivery}</td>
        <td class="px-3 py-2">${code}</td>
        <td class="px-3 py-2 whitespace-nowrap">${r.status === 'PENDING' ? esc(r.remainingSeconds) + 's left' : esc(formatTime(r.expiresAt))}</td>
      </tr>`;
    }).join('');
  }

  function renderSummary(s) {
    $('sTotal').textContent = s.total;
    $('sPending').textContent = s.pending;
    $('sVerified').textContent = s.verified;
    $('sExpired').textContent = s.expired + s.locked;
    $('sFailed').textContent = s.deliveryFailed;
  }

  async function load() {
    if (!token) return;
    const params = new URLSearchParams();
    if ($('appFilter').value) params.set('app', $('appFilter').value);
    if ($('statusFilter').value) params.set('status', $('statusFilter').value);
    try {
      const res = await fetch(`/api/admin/otp/requests?${params}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (res.status === 401 || res.status === 403) return showSignedOut();
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not load OTP requests.');
      renderBanner(data.mode);
      renderSummary(data.summary);
      renderRows(data.requests);
      $('updated').textContent = `Updated ${formatTime(new Date().toISOString())}`;
    } catch (error) {
      $('updated').textContent = error.message;
    }
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('loginError').textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('username').value, password: $('password').value }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Sign in failed.');
      token = data.token;
      showSignedIn(data.adminUser.name);
      await load();
      timer = setInterval(load, 4000);
    } catch (error) {
      $('loginError').textContent = error.message;
    }
  });

  $('signOut').addEventListener('click', showSignedOut);
  $('appFilter').addEventListener('change', load);
  $('statusFilter').addEventListener('change', load);
})();
