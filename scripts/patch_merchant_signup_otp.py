from pathlib import Path

FILES = [
    Path('apps/backend/portal-src/merchant.html'),
    Path('apps/backend/public/merchant.html'),
]

STATE_ANCHOR = "      const [regGstin, setRegGstin] = useState('');"
STATE_INSERT = STATE_ANCHOR + "\n      const [regOtpSent, setRegOtpSent] = useState(false);\n      const [regOtpCode, setRegOtpCode] = useState('');"

FUNCTION_ANCHOR = "      const handleRegisterBusiness = async (e) => {"
FUNCTION_INSERT = '''      const handleSendRegistrationOtp = async (e) => {
        e.preventDefault();
        setAuthError('');
        if (!regPhone || regPhone.length < 10) {
          setAuthError('Please enter a valid 10-digit mobile number.');
          return;
        }
        setIsAuthSubmitting(true);
        try {
          const response = await nativeMerchantFetch('/api/auth/send-otp', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: regPhone })
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Could not send OTP.');
          setRegOtpCode(result.otp || '');
          setRegOtpSent(true);
        } catch (error) {
          setAuthError(error.message || 'Could not send OTP.');
        } finally {
          setIsAuthSubmitting(false);
        }
      };

'''

PHONE_INPUT = '        <input type="text" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-white font-mono" placeholder="9849012345" required />'
PHONE_INPUT_PATCHED = '        <input type="text" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-white font-mono" placeholder="9849012345" required disabled={regOtpSent} />'

SUBMIT_INPUT = '''<button type="submit">
          {isAuthSubmitting ? 'Creating Business Account...' : 'Complete Registration & Launch Workspace'}
        </button>'''
SUBMIT_PATCHED = '''<div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-slate-300 mb-1">Phone Verification OTP</label>
                {regOtpSent ? (
                  <input
                    value={regOtpCode}
                    onChange={(e) => setRegOtpCode(e.target.value.replace(/\\D/g, '').slice(0, 6))}
                    placeholder="6-digit OTP"
                    maxLength="6"
                    inputMode="numeric"
                    required
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
                  />
                ) : (
                  <p className="text-xs text-slate-500 py-2">Send a verification OTP before creating the business account.</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleSendRegistrationOtp}
                disabled={isAuthSubmitting || regOtpSent}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold hover:bg-slate-600 disabled:opacity-50"
              >
                {isAuthSubmitting ? 'Sending OTP...' : (regOtpSent ? 'OTP Sent' : 'Send Verification OTP')}
              </button>
            </div>
            <button type="submit" disabled={!regOtpSent || !regOtpCode || isAuthSubmitting}>
          {isAuthSubmitting ? 'Creating Business Account...' : 'Complete Registration & Launch Workspace'}
        </button>'''

for path in FILES:
    text = path.read_text(encoding='utf-8')
    original = text

    if text.count(STATE_ANCHOR) != 1:
        raise SystemExit(f'{path}: expected one registration state anchor, found {text.count(STATE_ANCHOR)}')
    text = text.replace(STATE_ANCHOR, STATE_INSERT, 1)

    if text.count(FUNCTION_ANCHOR) != 1:
        raise SystemExit(f'{path}: expected one registration handler, found {text.count(FUNCTION_ANCHOR)}')
    text = text.replace(FUNCTION_ANCHOR, FUNCTION_INSERT + FUNCTION_ANCHOR, 1)

    start = text.index(FUNCTION_ANCHOR)
    end = text.find("\n      const handleLogout = () => {", start)
    if end < 0:
        raise SystemExit(f'{path}: registration handler end not found')
    block = text[start:end]
    if block.count('otp: otpCode') != 1:
        raise SystemExit(f'{path}: expected one registration otp: otpCode, found {block.count("otp: otpCode")}')
    block = block.replace('otp: otpCode', 'otp: regOtpCode', 1)
    text = text[:start] + block + text[end:]

    if text.count(PHONE_INPUT) != 1:
        raise SystemExit(f'{path}: expected exact registration phone input once, found {text.count(PHONE_INPUT)}')
    text = text.replace(PHONE_INPUT, PHONE_INPUT_PATCHED, 1)

    if text.count(SUBMIT_INPUT) != 1:
        raise SystemExit(f'{path}: expected exact registration submit block once, found {text.count(SUBMIT_INPUT)}')
    text = text.replace(SUBMIT_INPUT, SUBMIT_PATCHED, 1)

    marker = "setAuthMode('REGISTER');"
    if text.count(marker) != 1:
        raise SystemExit(f'{path}: expected one REGISTER mode transition, found {text.count(marker)}')
    text = text.replace(marker, "setAuthMode('REGISTER'); setRegOtpSent(false); setRegOtpCode('');", 1)

    if text == original:
        raise SystemExit(f'{path}: no changes produced')
    path.write_text(text, encoding='utf-8')
    print(f'patched {path}')

Path(__file__).unlink()
