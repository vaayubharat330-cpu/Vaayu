from pathlib import Path
import re

FILES = [
    Path('apps/backend/portal-src/merchant.html'),
    Path('apps/backend/public/merchant.html'),
]

STATE_ANCHOR = "      const [regGstin, setRegGstin] = useState('');"
STATE_INSERT = STATE_ANCHOR + "\n      const [regOtpSent, setRegOtpSent] = useState(false);\n      const [regOtpCode, setRegOtpCode] = useState('');"

FUNCTION_ANCHOR = "      const handleRegisterBusiness = async (e) => {"
FUNCTION_INSERT = r'''      const handleSendRegistrationOtp = async (e) => {
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

REG_PHONE_RE = re.compile(r'''(<input\s+value=\{regPhone\}[\s\S]*?onChange=\{\(e\) => setRegPhone\(e\.target\.value\)\}[\s\S]*?required\s*/>)''')
REG_SUBMIT_RE = re.compile(r'''(\s*<button\s+type="submit"\s+className="[^"]*"\s*>\s*\{isAuthSubmitting \? 'Creating Business Account\.\.\.' : 'Complete Registration & Launch Workspace'\}\s*</button>)''')

for path in FILES:
    text = path.read_text(encoding='utf-8')
    original = text

    if text.count(STATE_ANCHOR) != 1:
        raise SystemExit(f'{path}: expected exactly one registration state anchor, found {text.count(STATE_ANCHOR)}')
    text = text.replace(STATE_ANCHOR, STATE_INSERT, 1)

    if FUNCTION_ANCHOR not in text:
        raise SystemExit(f'{path}: handleRegisterBusiness anchor not found')
    text = text.replace(FUNCTION_ANCHOR, FUNCTION_INSERT + FUNCTION_ANCHOR, 1)

    start = text.index(FUNCTION_ANCHOR)
    end_marker = "\n      const handleLogout = () => {"
    end = text.find(end_marker, start + len(FUNCTION_ANCHOR))
    if end == -1:
        raise SystemExit(f'{path}: could not find end of handleRegisterBusiness')
    block = text[start:end]
    if block.count('otp: otpCode') != 1:
        raise SystemExit(f'{path}: expected exactly one registration OTP verification call, found {block.count("otp: otpCode")}')
    block = block.replace('otp: otpCode', 'otp: regOtpCode', 1)
    text = text[:start] + block + text[end:]

    matches = list(REG_PHONE_RE.finditer(text))
    if len(matches) != 1:
        raise SystemExit(f'{path}: expected exactly one registration phone input, found {len(matches)}')
    phone_input = matches[0].group(1)
    if 'disabled={regOtpSent}' not in phone_input:
        phone_input = phone_input[:-2] + ' disabled={regOtpSent} />'
    text = text[:matches[0].start(1)] + phone_input + text[matches[0].end(1):]

    submit_match = REG_SUBMIT_RE.search(text)
    if not submit_match:
        raise SystemExit(f'{path}: registration submit button not found')
    otp_ui = '''
              <div className="flex gap-2 items-end">
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
'''
    submit = submit_match.group(1)
    submit = submit.replace('<button type="submit"', '<button type="submit" disabled={!regOtpSent || !regOtpCode || isAuthSubmitting}', 1)
    replacement = otp_ui + submit
    text = text[:submit_match.start(1)] + replacement + text[submit_match.end(1):]

    if "setAuthMode('REGISTER');" in text:
        text = text.replace("setAuthMode('REGISTER');", "setAuthMode('REGISTER'); setRegOtpSent(false); setRegOtpCode('');", 1)
    elif 'setAuthMode("REGISTER");' in text:
        text = text.replace('setAuthMode("REGISTER");', 'setAuthMode("REGISTER"); setRegOtpSent(false); setRegOtpCode(\'\');', 1)

    if text == original:
        raise SystemExit(f'{path}: no changes produced')
    path.write_text(text, encoding='utf-8')
    print(f'patched {path}')

# This helper is intentionally ephemeral: after a successful patch, remove the helper itself.
helper = Path(__file__)
try:
    helper.unlink()
except OSError:
    pass
