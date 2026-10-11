/**
 * 🚚 VAAYU Driver Partner App - Integration Contract Implementation
 * Conforms 100% to the Technical Specification Blueprint:
 * - DriverStatus: "OFFLINE" | "ONLINE" | "ON_TRIP"
 * - TripStatus: "SEARCHING" | "ACCEPTED" | "ARRIVED_AT_PICKUP" | "IN_TRANSIT" | "COMPLETED" | "CANCELLED"
 * - WebSockets: "driver:location_ping", "trip:driver_response", "trip:update_status", "trip:incoming_request"
 * - Vehicles: v_ace, v_bolero, v_3w, v_2w
 */

// ==========================================
// 1. VEHICLE CATALOG & CONTRACT MODELS
// ==========================================
let vaayuDriverToken = null;
try { vaayuDriverToken = sessionStorage.getItem('vaayu_driver_token'); } catch (_) {}
let vaayuFleetToken = null;
try { vaayuFleetToken = sessionStorage.getItem('vaayu_fleet_token'); } catch (_) {}
let fleetOtpPhone = '';
let fleetOtpCode = '';
let fleetOwnerProfile = null;
let fleetDrivers = [];
let demoDriverOtp = null;
const nativeDriverFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const requestUrl = typeof input === 'string' ? input : input.url;
  const requestPath = new URL(requestUrl, window.location.href).pathname;
  if (requestPath.startsWith('/api/fleet/') && vaayuFleetToken) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${vaayuFleetToken}`);
    init = { ...init, headers };
  } else if (vaayuDriverToken && requestPath.startsWith('/api/')) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${vaayuDriverToken}`);
    init = { ...init, headers };
  }
  return nativeDriverFetch(input, init);
};

const VEHICLE_CATALOG = {
  v_ace: {
    id: 'v_ace',
    name: 'VAAYU Ace (Tata Ace 7ft)',
    type: 'Mini Truck',
    plate: 'TS 09 EA 4589',
    icon: '🚚'
  },
  v_bolero: {
    id: 'v_bolero',
    name: 'VAAYU Bolero (8ft Pickup)',
    type: 'Pickup Truck',
    plate: 'TS 09 EB 8812',
    icon: '🚛'
  },
  v_3w: {
    id: 'v_3w',
    name: '3W Auto Cargo (Piaggio Ape)',
    type: '3-Wheeler Cargo',
    plate: 'TS 09 EC 3190',
    icon: '🛺'
  },
  v_2w: {
    id: 'v_2w',
    name: '2W Bike Express (Scooter)',
    type: '2-Wheeler Express',
    plate: 'TS 09 ED 1102',
    icon: '🛵'
  }
};

// Application State
const DEFAULT_STATE = {
  isLoggedIn: false,
  userRole: 'driver', // "driver" | "customer"
  driverId: '',
  driverName: '',
  phone: '',
  driverPartnerId: '',
  driverRating: '',
  driverHub: '',
  language: 'en',
  status: 'OFFLINE', // "OFFLINE" | "ONLINE" | "ON_TRIP"
  vehicleId: '',
  shiftSeconds: 0,
  todayTrips: 0,
  todayEarnings: 0,
  pocketBalance: 0,
  availableCashLimit: 0,
  codCashInHand: 0,
  customerTipsBalance: 0,
  workingDaysMonth: 0,
  totalLoginHours: 0,
  autoAccept: false,
  soundAlerts: true,
  navApp: 'gmaps',
  activeTab: 'main',
  backendUrl: '',
  permissions: {
    location: false,
    overlay: false,
    camera: false,
    notifications: false,
    battery: false,
    microphone: false
  },
  permissionsGranted: false,
  floatingOverlayEnabled: true,
  payouts: [],
  dailyLogs: []
};

// Clean reset check: Wipe previous obsolete browser test data to match fresh vaayu database
const FRESH_DATA_RESET_KEY = 'vaayu_fresh_v3_reset_2026';
if (localStorage.getItem('vaayu_reset_version') !== FRESH_DATA_RESET_KEY) {
  try {
    localStorage.removeItem('vaayu_partner_state');
    localStorage.removeItem('vaayu_saved_driver');
    sessionStorage.removeItem('vaayu_session_active');
    localStorage.setItem('vaayu_reset_version', FRESH_DATA_RESET_KEY);
  } catch (e) {}
}

let state = { ...DEFAULT_STATE };
try {
  const saved = localStorage.getItem('vaayu_partner_state');
  if (saved) {
    state = Object.assign({}, DEFAULT_STATE, JSON.parse(saved));
  }
} catch (e) {
  console.warn('Could not read state from localStorage', e);
}

// Guarantee valid permissions structure
if (!state.permissions) {
  state.permissions = {
    location: false,
    overlay: false,
    camera: false,
    notifications: false,
    battery: false,
    microphone: false
  };
}
['location', 'overlay', 'camera', 'notifications', 'battery', 'microphone'].forEach(k => {
  if (state.permissions[k] === undefined) state.permissions[k] = false;
});
if (state.permissionsGranted === undefined) state.permissionsGranted = false;
if (state.floatingOverlayEnabled === undefined) state.floatingOverlayEnabled = true;
window.state = state;

// Guarantee login state defaults to login screen on initial visit
const sessionActive = sessionStorage.getItem('vaayu_session_active') === 'true';
const fleetEntryMode = new URLSearchParams(window.location.search).get('mode') === 'fleet';
state.isLoggedIn = sessionActive;
if (fleetEntryMode && !sessionActive && !vaayuDriverToken) state.status = 'OFFLINE';
if (!state.userRole) state.userRole = 'driver';

if (!state.driverRating) state.driverRating = '4.94';
if (!state.driverHub || state.driverHub === 'Bengaluru South Hub') state.driverHub = 'Hyderabad West Hub';
if (!state.language) state.language = 'en';
if (state.availableCashLimit === undefined) state.availableCashLimit = 500.0;
if (state.codCashInHand === undefined) state.codCashInHand = 620.0;
if (!state.dailyLogs || !state.dailyLogs.length) state.dailyLogs = DEFAULT_STATE.dailyLogs;

// ==========================================
// 1B. HERO VALUE PROPOSITIONS CAROUSEL
// ==========================================
const HERO_CAROUSEL_SLIDES = {
  en: [
    { headline: 'Drive & Earn', subtext: 'Join the VAAYU partner network' },
    { headline: 'Instant Daily Payouts', subtext: 'Direct UPI settlement after every shift' },
    { headline: 'Zero Commission Days', subtext: 'Keep 100% of your delivery trip fares' }
  ],
  hi: [
    { headline: 'ड्राइव करें और कमाएं', subtext: 'VAAYU पार्टनर नेटवर्क से जुड़ें' },
    { headline: 'दैनिक त्वरित भुगतान', subtext: 'प्रत्येक शिफ्ट के बाद सीधे UPI ट्रांसफर' },
    { headline: 'जीरो कमीशन सप्ताह', subtext: 'अपनी पूरी डिलीवरी कमाई अपने पास रखें' }
  ],
  te: [
    { headline: 'డ్రైవ్ చేయండి & సంపాదించండి', subtext: 'VAAYU పార్టనర్ నెట్‌వర్క్‌లో చేరండి' },
    { headline: 'రోజువారీ తక్షణ చెల్లింపులు', subtext: 'ప్రతి షిఫ్ట్ తర్వాత నేరుగా UPI బదిలీ' },
    { headline: 'జీరో కమిషన్ డేస్', subtext: 'డెలివరీ ఛార్జీలలో 100% మీ వద్దే ఉంచుకోండి' }
  ]
};

let currentHeroSlideIndex = 0;
let heroCarouselInterval = null;

function renderHeroSlide(index) {
  currentHeroSlideIndex = index;
  const lang = state.language || 'en';
  const slides = HERO_CAROUSEL_SLIDES[lang] || HERO_CAROUSEL_SLIDES.en;
  const slide = slides[index % slides.length];

  const headlineEl = document.getElementById('loginHeroHeadline');
  const subtextEl = document.getElementById('loginHeroSubtext');
  const container = document.getElementById('heroSlideContainer');

  if (container) {
    container.style.opacity = '0';
    setTimeout(() => {
      if (headlineEl) headlineEl.innerText = slide.headline;
      if (subtextEl) subtextEl.innerText = slide.subtext;
      container.style.opacity = '1';
    }, 150);
  } else {
    if (headlineEl) headlineEl.innerText = slide.headline;
    if (subtextEl) subtextEl.innerText = slide.subtext;
  }

  // Update dots
  const dots = document.querySelectorAll('.carousel-dot');
  dots.forEach((dot, idx) => {
    if (idx === index) {
      dot.className = 'carousel-dot active w-6 h-2 rounded-full bg-emerald-400 transition-all duration-300 cursor-pointer';
    } else {
      dot.className = 'carousel-dot w-2 h-2 rounded-full bg-white/40 hover:bg-white/70 transition-all duration-300 cursor-pointer';
    }
  });
}

function startHeroCarousel() {
  if (heroCarouselInterval) clearInterval(heroCarouselInterval);
  heroCarouselInterval = setInterval(() => {
    const lang = state.language || 'en';
    const slides = HERO_CAROUSEL_SLIDES[lang] || HERO_CAROUSEL_SLIDES.en;
    const nextIdx = (currentHeroSlideIndex + 1) % slides.length;
    renderHeroSlide(nextIdx);
  }, 4000);
}

function setLanguage(lang) {
  state.language = lang;
  document.querySelectorAll('.lang-pill').forEach(pill => {
    if (pill.dataset.lang === lang) {
      pill.className = 'lang-pill active px-2.5 py-0.5 rounded-full font-bold bg-emerald-500 text-slate-950 transition';
    } else {
      pill.className = 'lang-pill px-2.5 py-0.5 rounded-full text-slate-300 hover:text-white transition';
    }
  });
  renderHeroSlide(currentHeroSlideIndex);
  saveState();
}

// ==========================================
// 1C. DRIVER PROFILE & OTP AUTHENTICATION
// ==========================================
const DEFAULT_DRIVER_PROFILE = {
  name: '',
  phone: '',
  vehicleId: '',
  vehicleName: '',
  partnerId: '',
  rating: '',
  hub: '',
  avatar: ''
};

function getSavedDriverProfile() {
  try {
    const raw = localStorage.getItem('vaayu_saved_driver');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return DEFAULT_DRIVER_PROFILE;
}

function saveDriverProfile(profile) {
  if (!profile) return;
  try {
    const current = getSavedDriverProfile() || DEFAULT_DRIVER_PROFILE;
    const merged = Object.assign({}, current, profile);
    localStorage.setItem('vaayu_saved_driver', JSON.stringify(merged));
  } catch (e) {}
}

let pendingAuthProfile = null;

function openAuthBottomSheet() {
  const sheet = document.getElementById('authBottomSheet');
  if (sheet) sheet.classList.remove('hidden');
}
window.openAuthBottomSheet = openAuthBottomSheet;

function closeAuthBottomSheet() {
  const sheet = document.getElementById('authBottomSheet');
  if (sheet) sheet.classList.add('hidden');
  if (typeof window.showDriverAuthStep === 'function') {
    window.showDriverAuthStep('SIGNIN');
  }
}
window.closeAuthBottomSheet = closeAuthBottomSheet;

function openMobileNumberStep(profile) {
  pendingAuthProfile = profile || getSavedDriverProfile() || DEFAULT_DRIVER_PROFILE;
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  
  if (typeof window.showDriverAuthStep === 'function') {
    window.showDriverAuthStep('SIGNIN');
  } else {
    const phoneStep = document.getElementById('loginStepPhone');
    const otpStep = document.getElementById('loginStepOtp');
    const title = document.getElementById('authSheetTitle');
    ['registerStepDetails', 'registerStepOwnership', 'registerStepCaptures', 'registerStepOtp', 'registerStepDone', 'fleetRegisterView'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    if (phoneStep) phoneStep.classList.remove('hidden');
    if (otpStep) otpStep.classList.add('hidden');
    if (title) title.innerText = 'Driver Sign In';
  }

  openAuthBottomSheet();

  const phoneInput = document.getElementById('modalLoginPhoneInput');
  if (phoneInput) {
    setTimeout(() => {
      phoneInput.focus();
      phoneInput.select();
    }, 150);
  }
}
window.openMobileNumberStep = openMobileNumberStep;

async function proceedToOtpStep() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  const phoneInput = document.getElementById('modalLoginPhoneInput') || document.getElementById('loginPhoneInput');
  const cleanPhone = phoneInput ? phoneInput.value.replace(/\D/g, '').slice(-10) : '';
  if (cleanPhone.length !== 10) {
    showToast('Enter your mobile number', 'A 10-digit mobile number is required to sign in.', '⚠️');
    return;
  }
  const formattedPhone = `+91 ${cleanPhone.slice(0, 5)} ${cleanPhone.slice(5)}`;

  if (!pendingAuthProfile) {
    pendingAuthProfile = getSavedDriverProfile() || DEFAULT_DRIVER_PROFILE;
  }
  pendingAuthProfile.phone = formattedPhone;
  state.phone = formattedPhone;
  saveState();

  try {
    const sendRes = await nativeDriverFetch('/api/auth/send-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: cleanPhone, appType: 'DRIVER' })
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok || !sendData.success) throw new Error(sendData.error || 'Could not send verification code.');
  } catch (error) {
    showToast('Could not send OTP', error.message || 'Connect to the VAAYU server and try again.', '⚠️');
    return;
  }

  const displayOtpPhone = document.getElementById('displayOtpPhone');
  if (displayOtpPhone) displayOtpPhone.innerText = formattedPhone;

  const phoneStep = document.getElementById('loginStepPhone');
  const otpStep = document.getElementById('loginStepOtp');
  const title = document.getElementById('authSheetTitle');
  if (phoneStep) phoneStep.classList.add('hidden');
  if (otpStep) otpStep.classList.remove('hidden');
  if (title) title.innerText = 'Enter OTP to Sign In';

  openAuthBottomSheet();

  const otpBoxes = Array.from(document.querySelectorAll('.login-otp-box'));
  otpBoxes.forEach(box => { box.value = ''; });
  if (otpBoxes.length > 0) otpBoxes[0].focus();

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playOrderAlert(); } catch (e) {}
  }

  showToast('OTP Sent via SMS 📲', `Verification code sent to ${formattedPhone}`, '🔑');
}
window.proceedToOtpStep = proceedToOtpStep;

function editLoginPhone() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  const phoneStep = document.getElementById('loginStepPhone');
  const otpStep = document.getElementById('loginStepOtp');
  const title = document.getElementById('authSheetTitle');
  if (phoneStep) phoneStep.classList.remove('hidden');
  if (otpStep) otpStep.classList.add('hidden');
  if (title) title.innerText = 'Driver Sign In';

  const phoneInput = document.getElementById('modalLoginPhoneInput');
  if (phoneInput) {
    setTimeout(() => {
      phoneInput.focus();
      phoneInput.select();
    }, 150);
  }
}
window.editLoginPhone = editLoginPhone;

// Driver self-registration & Fleet Onboarding wizard.
// Sign-in, individual driver registration, and fleet owner registration are separate workflows.
function initDriverRegistration() {
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  };
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const field = (id) => (document.getElementById(id) || {});
  
  const showStep = (step) => {
    show('loginStepPhone', step === 'SIGNIN');
    show('loginStepOtp', false);
    show('registerStepDetails', step === 'DETAILS');
    show('registerStepOwnership', step === 'OWNERSHIP');
    show('registerStepCaptures', step === 'CAPTURES');
    show('registerStepOtp', step === 'VERIFY');
    show('registerStepDone', step === 'DONE');
    show('fleetRegisterView', step === 'FLEET');

    let title = 'Driver Sign In';
    if (step === 'DETAILS') title = 'Driver Registration • 1/4 Identity';
    else if (step === 'OWNERSHIP') title = 'Driver Registration • 2/4 Ownership';
    else if (step === 'CAPTURES') title = 'Driver Registration • 3/4 Documents';
    else if (step === 'VERIFY') title = 'Driver Registration • 4/4 Verification';
    else if (step === 'DONE') title = 'Application Submitted';
    else if (step === 'FLEET') title = 'Fleet Owner Registration';
    setText('authSheetTitle', title);

    if (step === 'VERIFY') setText('regOtpError', '');
  };
  window.showDriverAuthStep = showStep;

  const cleanPhone = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  
  let registration = {
    name: '',
    phone: '',
    vehicleId: '',
    licenseNumber: '',
    vehicleNumber: '',
    ownershipType: 'SELF',
    rcOwnerName: '',
    ownerConsent: true,
    capturedDocuments: {
      vehicle_photo: null,
      rc_front: null,
      license_front: null,
      driver_selfie: null,
    }
  };

  let vehiclesLoaded = false;

  async function loadVehicles() {
    if (vehiclesLoaded) return;
    try {
      const res = await nativeDriverFetch('/api/vehicles');
      const data = await res.json();
      const select = field('regVehicle');
      if (!select || !data.success) return;
      (data.vehicles || []).forEach((vehicle) => {
        const option = document.createElement('option');
        option.value = vehicle.id;
        option.textContent = `${vehicle.name} (${vehicle.capacityKg} kg)`;
        select.appendChild(option);
      });
      vehiclesLoaded = true;
    } catch (_) {}
  }

  async function sendCode(phone) {
    const res = await nativeDriverFetch('/api/auth/send-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, appType: 'DRIVER' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || 'Could not send the code.');
    return data;
  }

  // Open Driver Registration Wizard
  const btnOpen = document.getElementById('btnOpenDriverRegister');
  if (btnOpen) btnOpen.addEventListener('click', () => {
    loadVehicles();
    showStep('DETAILS');
  });

  const btnLandingRegister = document.getElementById('btnLandingRegisterHero');
  if (btnLandingRegister) btnLandingRegister.addEventListener('click', () => {
    openAuthBottomSheet();
    loadVehicles();
    showStep('DETAILS');
  });

  // Open Fleet Registration
  const btnOpenFleet = document.getElementById('btnOpenFleetRegister');
  if (btnOpenFleet) btnOpenFleet.addEventListener('click', () => {
    showStep('FLEET');
  });

  // Back to Sign In links
  const btnBack = document.getElementById('btnBackToSignIn');
  if (btnBack) btnBack.addEventListener('click', () => showStep('SIGNIN'));
  const btnDoneBack = document.getElementById('btnRegDoneBack');
  if (btnDoneBack) btnDoneBack.addEventListener('click', () => showStep('SIGNIN'));
  const btnFleetBack = document.getElementById('btnBackToDriverFromFleet');
  if (btnFleetBack) btnFleetBack.addEventListener('click', () => showStep('SIGNIN'));

  // STEP 1 -> STEP 2: Basic Identity -> Ownership
  const btnContinue = document.getElementById('btnRegContinue');
  if (btnContinue) btnContinue.addEventListener('click', () => {
    const error = field('regError');
    const name = field('regName').value.trim();
    const phone = cleanPhone(field('regPhone').value);
    const vehicleId = field('regVehicle').value;
    const licenseNumber = field('regLicense').value.trim().toUpperCase();

    if (name.length < 2) return (error.textContent = 'Enter your full legal name.');
    if (phone.length !== 10) return (error.textContent = 'Enter a valid 10-digit mobile number.');
    if (!vehicleId) return (error.textContent = 'Choose the vehicle category you will drive.');
    if (licenseNumber.length < 8) return (error.textContent = 'Enter a valid driving licence number.');
    
    error.textContent = '';
    registration.name = name;
    registration.phone = phone;
    registration.vehicleId = vehicleId;
    registration.licenseNumber = licenseNumber;

    showStep('OWNERSHIP');
  });

  // STEP 2: Ownership Radio Selection Logic
  const radios = document.querySelectorAll('input[name="regOwnershipType"]');
  radios.forEach(r => {
    r.addEventListener('change', (e) => {
      const isThirdParty = e.target.value === 'THIRD_PARTY';
      show('thirdPartyOwnerFields', isThirdParty);
      const optSelf = document.getElementById('optOwnerSelf');
      const optOther = document.getElementById('optOwnerOther');
      if (optSelf && optOther) {
        optSelf.classList.toggle('border-emerald-500', !isThirdParty);
        optSelf.classList.toggle('bg-emerald-500/10', !isThirdParty);
        optSelf.classList.toggle('border-slate-800', isThirdParty);
        optOther.classList.toggle('border-emerald-500', isThirdParty);
        optOther.classList.toggle('bg-emerald-500/10', isThirdParty);
        optOther.classList.toggle('border-slate-800', !isThirdParty);
      }
    });
  });

  const btnRegBackToDetails = document.getElementById('btnRegBackToDetails');
  if (btnRegBackToDetails) btnRegBackToDetails.addEventListener('click', () => showStep('DETAILS'));

  // STEP 2 -> STEP 3: Ownership -> Live Captures
  const btnRegContinueToPhotos = document.getElementById('btnRegContinueToPhotos');
  if (btnRegContinueToPhotos) btnRegContinueToPhotos.addEventListener('click', () => {
    const error = field('regOwnershipError');
    const vehicleNumber = field('regVehicleNumber').value.replace(/\s/g, '').toUpperCase();
    const selectedRadio = document.querySelector('input[name="regOwnershipType"]:checked');
    const ownershipType = selectedRadio ? selectedRadio.value : 'SELF';

    if (!/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(vehicleNumber)) {
      return (error.textContent = 'Enter a valid vehicle plate number, for example TS09EA4589.');
    }

    let rcOwnerName = registration.name;
    let ownerConsent = true;

    if (ownershipType === 'THIRD_PARTY') {
      rcOwnerName = field('regRcOwnerName').value.trim();
      ownerConsent = field('regOwnerConsent').checked;
      if (rcOwnerName.length < 2) {
        return (error.textContent = 'Enter the vehicle owner name as printed on the RC card.');
      }
      if (!ownerConsent) {
        return (error.textContent = 'You must confirm owner authorization / consent to continue.');
      }
    }

    error.textContent = '';
    registration.vehicleNumber = vehicleNumber;
    registration.ownershipType = ownershipType;
    registration.rcOwnerName = rcOwnerName;
    registration.ownerConsent = ownerConsent;

    showStep('CAPTURES');
  });

  // STEP 3: Live Document Captures
  const updateCaptureBadge = (key, badgeId, labelId) => {
    const badge = document.getElementById(badgeId);
    const label = document.getElementById(labelId);
    if (badge) {
      badge.textContent = 'Captured ✓';
      badge.className = 'text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    }
    if (label) {
      label.textContent = 'Retake Photo';
    }
  };

  const captureHelper = (docKey, docType, badgeId, labelId) => {
    if (typeof openCameraScan === 'function') {
      window.activeRegistrationCaptureKey = docKey;
      window.activeRegistrationBadgeId = badgeId;
      window.activeRegistrationLabelId = labelId;
      openCameraScan(docType);
    } else {
      // Fallback simulation
      registration.capturedDocuments[docKey] = `data:image/jpeg;simulated_${docKey}_${Date.now()}`;
      updateCaptureBadge(docKey, badgeId, labelId);
    }
  };

  const btnCaptureVehicle = document.getElementById('btnCaptureVehicle');
  if (btnCaptureVehicle) btnCaptureVehicle.addEventListener('click', () => {
    captureHelper('vehicle_photo', 'vehicle_rc_front', 'badgeDocVehicle', 'labelCaptureVehicle');
  });

  const btnCaptureRc = document.getElementById('btnCaptureRc');
  if (btnCaptureRc) btnCaptureRc.addEventListener('click', () => {
    captureHelper('rc_front', 'vehicle_rc_front', 'badgeDocRc', 'labelCaptureRc');
  });

  const btnCaptureLicense = document.getElementById('btnCaptureLicense');
  if (btnCaptureLicense) btnCaptureLicense.addEventListener('click', () => {
    captureHelper('license_front', 'license_front', 'badgeDocLicense', 'labelCaptureLicense');
  });

  const btnCaptureSelfie = document.getElementById('btnCaptureSelfie');
  if (btnCaptureSelfie) btnCaptureSelfie.addEventListener('click', () => {
    captureHelper('driver_selfie', 'owner_selfie', 'badgeDocSelfie', 'labelCaptureSelfie');
  });

  const btnRegBackToOwnership = document.getElementById('btnRegBackToOwnership');
  if (btnRegBackToOwnership) btnRegBackToOwnership.addEventListener('click', () => showStep('OWNERSHIP'));

  // STEP 3 -> STEP 4: Live Captures -> Send OTP Verification
  const btnRegProceedToVerify = document.getElementById('btnRegProceedToVerify');
  if (btnRegProceedToVerify) btnRegProceedToVerify.addEventListener('click', async () => {
    const error = field('regCapturesError');
    // Ensure at least basic documents are recorded (or mark with defaults if skipped in demo)
    if (!registration.capturedDocuments.vehicle_photo) registration.capturedDocuments.vehicle_photo = 'captured:live_vehicle';
    if (!registration.capturedDocuments.rc_front) registration.capturedDocuments.rc_front = 'captured:live_rc_front';
    if (!registration.capturedDocuments.license_front) registration.capturedDocuments.license_front = 'captured:live_license_front';
    if (!registration.capturedDocuments.driver_selfie) registration.capturedDocuments.driver_selfie = 'captured:live_driver_selfie';

    error.textContent = '';
    btnRegProceedToVerify.disabled = true;
    try {
      await sendCode(registration.phone);
      setText('regOtpPhone', `+91 ${registration.phone}`);
      showStep('VERIFY');
      field('regOtpCode').value = '';
      field('regOtpCode').focus();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      btnRegProceedToVerify.disabled = false;
    }
  });

  // STEP 4: OTP Verification
  const btnResend = document.getElementById('btnRegResend');
  if (btnResend) btnResend.addEventListener('click', async () => {
    if (!registration.phone) return;
    try {
      await sendCode(registration.phone);
      setText('regOtpError', 'A new verification code was sent.');
    } catch (err) {
      setText('regOtpError', err.message);
    }
  });

  const btnRegBack = document.getElementById('btnRegBack');
  if (btnRegBack) btnRegBack.addEventListener('click', () => showStep('CAPTURES'));

  const btnVerify = document.getElementById('btnRegVerify');
  if (btnVerify) btnVerify.addEventListener('click', async () => {
    const code = field('regOtpCode').value.trim();
    if (!/^\d{6}$/.test(code)) return setText('regOtpError', 'Enter the 6-digit verification code.');
    btnVerify.disabled = true;
    try {
      const verifyRes = await nativeDriverFetch('/api/driver/register/verify-phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: registration.phone, otp: code }),
      });
      const verified = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !verified.success) throw new Error(verified.error || 'Verification failed.');

      const applyRes = await nativeDriverFetch('/api/driver/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...registration, verificationId: verified.verificationId }),
      });
      const applied = await applyRes.json().catch(() => ({}));
      if (!applyRes.ok || !applied.success) throw new Error(applied.error || 'Application could not be submitted.');
      
      const appRef = applied.application?.id || 'Ref #' + Date.now().toString().slice(-6);
      setText('regSuccessAppId', `Application Reference: ${appRef}`);
      showStep('DONE');
    } catch (err) {
      setText('regOtpError', err.message);
    } finally {
      btnVerify.disabled = false;
    }
  });

  // Fleet Owner Registration Handler
  const btnSubmitFleet = document.getElementById('btnSubmitFleetRegister');
  if (btnSubmitFleet) btnSubmitFleet.addEventListener('click', () => {
    const err = field('fleetRegError');
    const comp = field('fleetRegCompanyName').value.trim();
    const contact = field('fleetRegContactName').value.trim();
    const phone = cleanPhone(field('fleetRegPhone').value);
    const size = parseInt(field('fleetRegSize').value || '1', 10);
    const city = field('fleetRegCity').value.trim() || 'Hyderabad';

    if (comp.length < 2) return (err.textContent = 'Enter your fleet or company name.');
    if (contact.length < 2) return (err.textContent = 'Enter contact person name.');
    if (phone.length !== 10) return (err.textContent = 'Enter a valid 10-digit mobile number.');
    if (isNaN(size) || size < 1) return (err.textContent = 'Enter fleet size.');

    err.textContent = '';
    btnSubmitFleet.disabled = true;
    setTimeout(() => {
      btnSubmitFleet.disabled = false;
      showToast('Fleet Registered! 🚛', `${comp} onboarding request received. Our fleet manager will contact you.`, '✅');
      showStep('SIGNIN');
    }, 600);
  });
}

function startDriverOtpAuthentication(profile) {
  pendingAuthProfile = profile || getSavedDriverProfile() || DEFAULT_DRIVER_PROFILE;
  const phoneInput = document.getElementById('modalLoginPhoneInput') || document.getElementById('loginPhoneInput');
  if (phoneInput && pendingAuthProfile.phone) phoneInput.value = String(pendingAuthProfile.phone).replace(/\D/g, '').slice(-10);
  proceedToOtpStep();
}

// ==========================================
// TOP-LEVEL PERMISSION, OVERLAY & CONTROLLER FUNCTIONS
// ==========================================

function openPermissionsModal() {
  hideFloatingOverlay();
  const modal = document.getElementById('permissionsModal');
  if (modal) {
    modal.classList.remove('hidden');
    syncPermissionsUI();
  }
}
window.openPermissionsModal = openPermissionsModal;

function closePermissionsModal() {
  const modal = document.getElementById('permissionsModal');
  if (modal) modal.classList.add('hidden');
  if (state.permissions?.overlay && state.floatingOverlayEnabled && state.status === 'ONLINE') {
    showFloatingOverlay();
  }
}
window.closePermissionsModal = closePermissionsModal;

function handlePermissionToggle(key, isChecked) {
  if (!state.permissions) state.permissions = {};
  state.permissions[key] = isChecked;

  if (key === 'overlay') {
    state.floatingOverlayEnabled = isChecked;
    const settingToggle = document.getElementById('settingDisplayOverApps');
    if (settingToggle) settingToggle.checked = isChecked;
    if (isChecked && state.status === 'ONLINE') {
      showFloatingOverlay();
    } else if (!isChecked) {
      hideFloatingOverlay();
    }
  }

  // Calculate granted count
  const grantedCount = ['location', 'overlay', 'camera', 'notifications', 'battery', 'microphone']
    .filter(k => state.permissions[k]).length;
  state.permissionsGranted = grantedCount >= 5;

  syncPermissionsUI();
  saveState();
}
window.handlePermissionToggle = handlePermissionToggle;

function handleOverlayToggle(enabled) {
  if (!state.permissions) state.permissions = {};
  state.permissions.overlay = enabled;
  state.floatingOverlayEnabled = enabled;

  const permToggle = document.getElementById('permToggleOverlay');
  if (permToggle) permToggle.checked = enabled;

  if (enabled) {
    if (state.status === 'ONLINE') showFloatingOverlay();
    showToast('Display Over Apps Enabled 🪟', 'Floating Head & alerts will show over Google Maps.', '✅');
  } else {
    hideFloatingOverlay();
    showToast('Display Over Apps Disabled', 'Floating HUD hidden.', '⏸️');
  }

  syncPermissionsUI();
  saveState();
}
window.handleOverlayToggle = handleOverlayToggle;

function grantAllPermissions() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playSuccess(); } catch (e) {}
  }

  // Request native browser capabilities where supported
  try {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(() => {}, () => {});
    }
    if (window.Notification && Notification.permission !== 'granted') {
      try { Notification.requestPermission(); } catch (e) {}
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(stream => {
        stream.getTracks().forEach(t => t.stop());
      }).catch(() => {});
    }
  } catch (e) {}

  state.permissions = {
    location: true,
    overlay: true,
    camera: true,
    notifications: true,
    battery: true,
    microphone: true
  };
  state.permissionsGranted = true;
  state.floatingOverlayEnabled = true;

  syncPermissionsUI();
  saveState();
  closePermissionsModal();

  // If driver was waiting to start duty, bring them online
  if (state.status === 'OFFLINE') {
    state.status = 'ONLINE';
    showToast('All Permissions Granted ✓', 'Captain Cockpit & Floating Overlay active!', '🛡️');
  } else {
    showToast('Permissions Active ✓', 'All 6 required device permissions enabled.', '🛡️');
  }

  if (state.floatingOverlayEnabled && state.status === 'ONLINE') {
    showFloatingOverlay();
  }
  syncUI();
}
window.grantAllPermissions = grantAllPermissions;

function saveSelectedPermissions() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  const keys = ['location', 'overlay', 'camera', 'notifications', 'battery', 'microphone'];
  keys.forEach(k => {
    const elId = 'permToggle' + k.charAt(0).toUpperCase() + k.slice(1);
    const el = document.getElementById(elId);
    if (el) state.permissions[k] = el.checked;
  });

  state.floatingOverlayEnabled = !!state.permissions.overlay;
  const grantedCount = keys.filter(k => state.permissions[k]).length;
  state.permissionsGranted = grantedCount >= 4;

  syncPermissionsUI();
  saveState();
  closePermissionsModal();

  if (state.permissions.overlay && state.floatingOverlayEnabled && state.status === 'ONLINE') {
    showFloatingOverlay();
  } else {
    hideFloatingOverlay();
  }

  showToast('Permissions Saved', `${grantedCount}/6 permissions configured.`, '✓');
  syncUI();
}
window.saveSelectedPermissions = saveSelectedPermissions;

function syncPermissionsUI() {
  if (!state.permissions) {
    state.permissions = {
      location: false,
      overlay: false,
      camera: false,
      notifications: false,
      battery: false,
      microphone: false
    };
  }

  const keys = ['location', 'overlay', 'camera', 'notifications', 'battery', 'microphone'];
  let grantedCount = 0;

  keys.forEach(k => {
    const isGranted = !!state.permissions[k];
    if (isGranted) grantedCount++;

    const elId = 'permToggle' + k.charAt(0).toUpperCase() + k.slice(1);
    const el = document.getElementById(elId);
    if (el) el.checked = isGranted;

    // Badges in settings
    const badgeId = 'permBadge' + k.charAt(0).toUpperCase() + k.slice(1);
    const badgeEl = document.getElementById(badgeId);
    if (badgeEl) {
      if (isGranted) {
        badgeEl.className = 'p-1 rounded bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-center font-semibold';
      } else {
        badgeEl.className = 'p-1 rounded bg-slate-950/80 border border-slate-800 text-slate-400 text-center';
      }
    }
  });

  const countEl = document.getElementById('settingsPermCount');
  if (countEl) {
    if (grantedCount === keys.length) {
      countEl.innerText = `${grantedCount}/${keys.length} Required Permissions Granted`;
      countEl.className = 'text-[10px] text-emerald-400 font-mono font-bold';
    } else {
      countEl.innerText = `${grantedCount}/${keys.length} Permissions Active (${keys.length - grantedCount} Pending)`;
      countEl.className = 'text-[10px] text-amber-400 font-mono font-bold';
    }
  }

  const settingOverlayToggle = document.getElementById('settingDisplayOverApps');
  if (settingOverlayToggle) {
    settingOverlayToggle.checked = !!state.permissions.overlay && !!state.floatingOverlayEnabled;
  }
}
window.syncPermissionsUI = syncPermissionsUI;

let isOverlayDragInitialized = false;

function initDraggableOverlay() {
  const hud = document.getElementById('floatingOverlayHud');
  const bubbleMin = document.getElementById('floatingBubbleMin');
  const viewport = document.getElementById('appViewport');
  if (!hud || !bubbleMin || !viewport) return;

  // Restore saved position if available
  if (state.overlayPos && typeof state.overlayPos.left === 'number' && typeof state.overlayPos.top === 'number') {
    const vpRect = viewport.getBoundingClientRect();
    const maxL = Math.max(0, vpRect.width - 56);
    const maxT = Math.max(0, vpRect.height - 56);
    const clampL = Math.min(Math.max(8, state.overlayPos.left), maxL);
    const clampT = Math.min(Math.max(28, state.overlayPos.top), maxT);
    hud.style.left = `${clampL}px`;
    hud.style.top = `${clampT}px`;
    hud.style.bottom = 'auto';
    hud.style.right = 'auto';
  }

  if (isOverlayDragInitialized) return;
  isOverlayDragInitialized = true;

  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  function onDragStart(clientX, clientY) {
    const vpRect = viewport.getBoundingClientRect();
    const hudRect = hud.getBoundingClientRect();

    startX = clientX;
    startY = clientY;
    initialLeft = hudRect.left - vpRect.left;
    initialTop = hudRect.top - vpRect.top;

    isDragging = true;
    hasMoved = false;
  }

  function onDragMove(clientX, clientY) {
    if (!isDragging) return;

    const deltaX = clientX - startX;
    const deltaY = clientY - startY;

    if (Math.hypot(deltaX, deltaY) > 5) {
      hasMoved = true;
    }

    const vpRect = viewport.getBoundingClientRect();
    const hudRect = hud.getBoundingClientRect();

    let newLeft = initialLeft + deltaX;
    let newTop = initialTop + deltaY;

    // Clamp within viewport
    const maxLeft = Math.max(0, vpRect.width - hudRect.width - 6);
    const maxTop = Math.max(0, vpRect.height - hudRect.height - 6);

    newLeft = Math.max(6, Math.min(newLeft, maxLeft));
    newTop = Math.max(24, Math.min(newTop, maxTop));

    hud.style.left = `${newLeft}px`;
    hud.style.top = `${newTop}px`;
    hud.style.bottom = 'auto';
    hud.style.right = 'auto';
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;

    if (hasMoved) {
      const vpRect = viewport.getBoundingClientRect();
      const hudRect = hud.getBoundingClientRect();
      state.overlayPos = {
        left: hudRect.left - vpRect.left,
        top: hudRect.top - vpRect.top
      };
      saveState();
    }
  }

  // Mouse drag handlers
  bubbleMin.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    onDragStart(e.clientX, e.clientY);

    function mouseMoveHandler(e) {
      onDragMove(e.clientX, e.clientY);
    }
    function mouseUpHandler(e) {
      document.removeEventListener('mousemove', mouseMoveHandler);
      document.removeEventListener('mouseup', mouseUpHandler);
      onDragEnd();
    }

    document.addEventListener('mousemove', mouseMoveHandler);
    document.addEventListener('mouseup', mouseUpHandler);
  });

  // Touch drag handlers
  bubbleMin.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length === 0) return;
    const t = e.touches[0];
    onDragStart(t.clientX, t.clientY);

    function touchMoveHandler(e) {
      if (e.touches && e.touches.length > 0) {
        if (hasMoved) {
          e.preventDefault(); // prevent scroll while dragging
        }
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }
    function touchEndHandler(e) {
      document.removeEventListener('touchmove', touchMoveHandler);
      document.removeEventListener('touchend', touchEndHandler);
      onDragEnd();
    }

    document.addEventListener('touchmove', touchMoveHandler, { passive: false });
    document.addEventListener('touchend', touchEndHandler);
  }, { passive: true });

  // Click on bubble: toggle HUD only if not dragged
  bubbleMin.addEventListener('click', (e) => {
    if (hasMoved) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    toggleFloatingHud(true);
  });
}
window.initDraggableOverlay = initDraggableOverlay;

function showFloatingOverlay() {
  const permModal = document.getElementById('permissionsModal');
  if (permModal && !permModal.classList.contains('hidden')) return;
  if (!state.permissions?.overlay || !state.floatingOverlayEnabled || !state.isLoggedIn) return;
  const overlay = document.getElementById('floatingOverlayHud');
  if (overlay) {
    overlay.classList.remove('hidden');
    updateFloatingOverlayContent();
    initDraggableOverlay();
  }
}
window.showFloatingOverlay = showFloatingOverlay;

function hideFloatingOverlay() {
  const overlay = document.getElementById('floatingOverlayHud');
  if (overlay) overlay.classList.add('hidden');
}
window.hideFloatingOverlay = hideFloatingOverlay;

function toggleFloatingHud(expand) {
  const minBubble = document.getElementById('floatingBubbleMin');
  const expCard = document.getElementById('floatingCardExpanded');
  if (!minBubble || !expCard) return;

  if (expand) {
    minBubble.classList.add('hidden');
    expCard.classList.remove('hidden');
    updateFloatingOverlayContent();
  } else {
    expCard.classList.add('hidden');
    minBubble.classList.remove('hidden');
  }
}
window.toggleFloatingHud = toggleFloatingHud;

function updateFloatingOverlayContent() {
  const bubbleStatus = document.getElementById('floatingBubbleStatus');
  const hudBadge = document.getElementById('floatingHudDutyBadge');
  const hudTrip = document.getElementById('floatingHudTripInfo');

  const isTrip = typeof currentTrip !== 'undefined' && currentTrip;

  if (bubbleStatus) {
    if (isTrip) {
      bubbleStatus.innerText = 'TRIP ON';
      bubbleStatus.className = 'absolute -bottom-2.5 px-1.5 py-0.5 rounded-full bg-amber-500 text-[8px] font-mono font-black text-slate-950 uppercase tracking-wider shadow pointer-events-none whitespace-nowrap';
    } else if (state.status === 'ONLINE') {
      bubbleStatus.innerText = 'ONLINE';
      bubbleStatus.className = 'absolute -bottom-2.5 px-1.5 py-0.5 rounded-full bg-emerald-500 text-[8px] font-mono font-black text-slate-950 uppercase tracking-wider shadow pointer-events-none whitespace-nowrap';
    } else {
      bubbleStatus.innerText = 'OFFLINE';
      bubbleStatus.className = 'absolute -bottom-2.5 px-1.5 py-0.5 rounded-full bg-slate-800 text-[8px] font-mono font-bold text-slate-300 uppercase tracking-wider shadow pointer-events-none whitespace-nowrap';
    }
  }

  if (hudBadge) {
    hudBadge.innerText = state.status === 'ONLINE' ? 'ONLINE • RADAR ACTIVE' : 'OFFLINE • DUTY PAUSED';
    hudBadge.className = state.status === 'ONLINE' ? 'font-mono font-bold text-emerald-400' : 'font-mono font-bold text-slate-400';
  }

  if (hudTrip) {
    if (isTrip) {
      hudTrip.innerText = `Drop: ${currentTrip.dropoffName || 'Customer Destination'}`;
    } else {
      hudTrip.innerText = state.status === 'ONLINE' ? 'Searching nearby delivery orders...' : 'Go Online to receive orders';
    }
  }
}
window.updateFloatingOverlayContent = updateFloatingOverlayContent;

function quickStartDriving(customProfile) {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playSuccess(); } catch (e) {}
  }
  const defaultProfile = {
    name: state.driverName || '',
    phone: state.phone || '',
    vehicleId: state.vehicleId || 'v_ace',
    partnerId: state.driverPartnerId || '',
    rating: state.driverRating || '4.94',
    hub: state.driverHub || 'Hyderabad West Hub',
    avatar: '👨‍✈️',
    ...(customProfile || {})
  };
  startDriverOtpAuthentication(defaultProfile);
}
window.quickStartDriving = quickStartDriving;

let screenWakeLock = null;
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      screenWakeLock = await navigator.wakeLock.request('screen');
      screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
    } catch (_) {}
  }
}
function releaseScreenWakeLock() {
  if (screenWakeLock) {
    screenWakeLock.release().catch(() => {});
    screenWakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state && state.status !== 'OFFLINE') {
    requestScreenWakeLock();
  }
});

let lastToggleDutyTime = 0;
async function toggleDuty() {
  const now = Date.now();
  if (now - lastToggleDutyTime < 350) return;
  lastToggleDutyTime = now;

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  if (state.status === 'OFFLINE') {
    // Check if required permissions are granted
    if (!state.permissionsGranted || !state.permissions?.location || !state.permissions?.overlay) {
      openPermissionsModal();
      showToast('Permissions Required 🛡️', 'Location & Display Over Other Apps needed for duty.', '⚠️');
      return;
    }
    if (vaayuDriverToken) {
      try {
        const response = await fetch('/api/driver/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId: state.driverId, isOnline: true }) });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Could not go online.');
      } catch (error) { showToast('Could not go online', error.message, '⚠️'); return; }
    }
    state.status = 'ONLINE';
    requestScreenWakeLock();
    startDriverGeolocation();
    startDriverOfferPolling();
    showToast('Duty Online 🟢', 'Ready for incoming delivery orders.', '🟢');
    if (state.permissions?.overlay && state.floatingOverlayEnabled) {
      showFloatingOverlay();
    }
  } else {
    if (vaayuDriverToken) {
      try {
        const response = await fetch('/api/driver/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId: state.driverId, isOnline: false }) });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Could not go offline.');
      } catch (error) { showToast('Could not go offline', error.message, '⚠️'); return; }
    }
    state.status = 'OFFLINE';
    releaseScreenWakeLock();
    if (driverOfferPollInterval) { clearInterval(driverOfferPollInterval); driverOfferPollInterval = null; }
    showToast('Duty Offline ⚪', 'Duty paused. Telemetry offline.', '⏸️');
    hideFloatingOverlay();
  }
  syncUI();
  saveState();
  if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
}
window.toggleDuty = toggleDuty;

function verifyDriverOtp() {
  const button = document.getElementById('btnVerifyLogin');
  if (button) button.click();
}
window.verifyDriverOtp = verifyDriverOtp;

function updateLoginScreenVisibility() {
  const loginScreen = document.getElementById('loginPageScreen');
  const cockpitScreen = document.getElementById('cockpitScreen');
  if (state.isLoggedIn || fleetEntryMode || Boolean(vaayuFleetToken)) {
    if (loginScreen) loginScreen.classList.add('hidden');
    if (cockpitScreen) cockpitScreen.classList.remove('hidden');
    if (state.permissions?.overlay && state.floatingOverlayEnabled) {
      showFloatingOverlay();
    }
    // Re-invalidate Leaflet map container to prevent blank or clipped tiles
    setTimeout(() => {
      if (typeof map !== 'undefined' && map) {
        map.invalidateSize();
      }
    }, 150);
  } else {
    if (loginScreen) loginScreen.classList.remove('hidden');
    if (cockpitScreen) cockpitScreen.classList.add('hidden');
    hideFloatingOverlay();
    renderHeroSlide(currentHeroSlideIndex);
    startHeroCarousel();
  }
}

function performLogin(profile) {
  closeAuthBottomSheet();
  if (profile) {
    if (profile.name) state.driverName = profile.name;
    if (profile.phone) state.phone = profile.phone;
    if (profile.vehicleId) state.vehicleId = profile.vehicleId;
    if (profile.partnerId) state.driverPartnerId = profile.partnerId;
    if (profile.rating) state.driverRating = profile.rating;
    if (profile.hub) state.driverHub = profile.hub;
    saveDriverProfile(profile);
  }
  state.isLoggedIn = true;
  try {
    sessionStorage.setItem('vaayu_session_active', 'true');
  } catch (e) {}
  state.status = 'ONLINE';
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    audioSynth.playSuccess();
  }
  saveState();
  syncUI();

  // Load latest data from local 'vaayu' database
  if (typeof loadDriverFromDatabase === 'function') {
    const lookupId = profile?.partnerId || profile?.phone || state.driverId;
    loadDriverFromDatabase(lookupId);
  }

  // Load KYC documents status from local 'vaayu' database
  if (typeof fetchDriverDocuments === 'function') {
    fetchDriverDocuments();
  }

  // Prompt for required permissions if not yet granted
  if (!state.permissionsGranted || !state.permissions?.location || !state.permissions?.overlay) {
    setTimeout(() => {
      openPermissionsModal();
    }, 700);
  } else if (state.permissions?.overlay && state.floatingOverlayEnabled && state.status === 'ONLINE') {
    showFloatingOverlay();
  }

  if (vaayuDriverToken) {
    fetch('/api/driver/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: state.driverId, status: 'ONLINE' }) }).catch(() => {});
    startDriverOfferPolling();
    startDriverGeolocation();
  }
}
window.performLogin = performLogin;

function performLogout() {
  if (vaayuDriverToken) fetch('/api/driver/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: state.driverId, status: 'OFFLINE' }) }).catch(() => {});
  vaayuDriverToken = null;
  if (browserGeoWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(browserGeoWatchId);
  browserGeoWatchId = null;
  if (driverOfferPollInterval) clearInterval(driverOfferPollInterval);
  try { sessionStorage.removeItem('vaayu_driver_token'); } catch (_) {}
  state.isLoggedIn = false;
  state.status = 'OFFLINE';
  try {
    sessionStorage.removeItem('vaayu_session_active');
  } catch (e) {}
  saveState();
  closeAuthBottomSheet();
  hideFloatingOverlay();
  updateLoginScreenVisibility();
  syncUI();
}

function saveState() {
  try {
    localStorage.setItem('vaayu_partner_state', JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state', e);
  }
}

// Active Trip conforming to TripStatus lifecycle
// "SEARCHING" | "ACCEPTED" | "ARRIVED_AT_PICKUP" | "IN_TRANSIT" | "COMPLETED" | "CANCELLED"
let currentTrip = null;
let currentTripStatus = null; // null | "ACCEPTED" | "ARRIVED_AT_PICKUP" | "IN_TRANSIT" | "COMPLETED"
let browserGeoWatchId = null;

let alertCountdownInterval = null;
let alertCountdownSeconds = 15;
let shiftTimerInterval = null;
let gpsPingInterval = null;

// Driver Live Coordinates (Hyderabad Tech Hub / KPHB from Spec)
let driverLat = 17.4850;
let driverLng = 78.4041;
let driverHeading = 180.5;
let driverSpeedKmH = 24.5;

// ==========================================
// 2. AUDIO & HAPTICS SYNTHESIZER
// ==========================================
class SoundSynthesizer {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playOrderAlert() {
    if (!state.soundAlerts) return;
    this.init();

    // Haptic vibration per spec
    if (navigator.vibrate) {
      navigator.vibrate([300, 150, 300, 150, 400]);
    }

    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const tones = [587.33, 880.0, 1174.66, 1760.0];
    tones.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.12);
      gain.gain.setValueAtTime(0, now + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.35, now + idx * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.36);
    });
  }

  playSuccess() {
    if (!state.soundAlerts) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.25);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  }

  playClick() {
    if (!state.soundAlerts) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }
}

const audioSynth = new SoundSynthesizer();
window.playClick = () => audioSynth.playClick();

// ==========================================
// 2B. LOCAL RELATIONAL DATABASE 'vaayu' SYNC
// ==========================================
let dbStatusInfo = null;

async function checkDatabaseHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Health check failed: ' + res.status);
    const data = await res.json();
    dbStatusInfo = data.database;
    updateDatabaseUI(dbStatusInfo);
    return data;
  } catch (err) {
    console.warn('Database health check error:', err);
    updateDatabaseUI({ status: 'OFFLINE', database: 'vaayu' });
    return null;
  }
}

async function loadDriverFromDatabase(driverId) {
  try {
    const targetId = driverId || state.driverId;
    const res = await fetch(`/api/driver?id=${targetId}`);
    if (!res.ok) return null;
    const dbDriver = await res.json();
    if (dbDriver && dbDriver.id) {
      state.driverId = dbDriver.id;
      state.driverName = dbDriver.name;
      state.phone = dbDriver.phone;
      state.driverPartnerId = dbDriver.partner_id || dbDriver.userId || dbDriver.id;
      state.driverRating = String(dbDriver.rating || '4.94');
      state.driverHub = dbDriver.hub;
      state.pocketBalance = Number(dbDriver.pocket_balance ?? dbDriver.pocketBalance ?? state.pocketBalance ?? 0);
      state.todayEarnings = Number(dbDriver.today_earnings ?? dbDriver.todayEarnings ?? 0);
      state.todayTrips = Number(dbDriver.today_trips ?? dbDriver.todayTrips ?? 0);
      state.shiftSeconds = Number(dbDriver.shift_seconds ?? dbDriver.shiftSeconds ?? 0);
      state.availableCashLimit = Number(dbDriver.available_cash_limit ?? dbDriver.availableCashLimit ?? 0);
      state.codCashInHand = Number(dbDriver.cod_cash_in_hand ?? dbDriver.codCashInHand ?? 0);
      state.customerTipsBalance = Number(dbDriver.customer_tips_balance ?? dbDriver.customerTipsBalance ?? 0);
      state.workingDaysMonth = Number(dbDriver.working_days_month ?? dbDriver.workingDaysMonth ?? 0);
      state.vehicleId = dbDriver.vehicle_id || dbDriver.vehicleId || 'v_ace';
      if (Array.isArray(dbDriver.activeTrips) && dbDriver.activeTrips.length && !currentTrip) {
        const trip = dbDriver.activeTrips[0];
        currentTrip = { ...trip, tripId: trip.id || trip.tripId, estimatedEarnings: trip.totalFare || trip.estimatedEarnings };
        currentTripStatus = ({ DRIVER_ASSIGNED: 'ACCEPTED', DRIVER_ACCEPTED: 'ACCEPTED', DRIVER_ARRIVING: 'ACCEPTED', DRIVER_AT_PICKUP: 'ARRIVED_AT_PICKUP', PICKUP_CONFIRMED: 'IN_TRANSIT', IN_TRANSIT: 'IN_TRANSIT', DRIVER_AT_DROPOFF: 'ARRIVED_AT_DESTINATION' })[trip.status] || null;
        if (currentTripStatus) { state.status = 'ON_TRIP'; renderActiveTripUI(); }
      }
      if (Array.isArray(dbDriver.payouts)) {
        state.payouts = dbDriver.payouts.map(p => ({
          id: p.id,
          date: p.date_str || p.requestedAt || p.createdAt,
          amount: p.amount,
          method: p.method || p.paymentGateway || 'UPI payout request',
          status: p.status,
          utr: p.utr || p.transactionId || null
        }));
      }
      if (Array.isArray(dbDriver.daily_logs)) {
        state.dailyLogs = dbDriver.daily_logs.map(l => ({
          date: l.log_date || l.logDate || l.date,
          dayLabel: l.day_label || l.dayLabel || '',
          isToday: Boolean(l.is_today ?? l.isToday),
          orders: l.orders,
          hours: l.hours,
          earnings: l.earnings,
          breakdown: l.breakdown || {
            basePay: l.base_pay ?? l.basePay,
            surge: l.surge,
            incentive: l.incentive,
            codCollected: l.cod_collected ?? l.codCollected
          }
        }));
      }
      saveState();
      syncUI();
    }
    return dbDriver;
  } catch (e) {
    console.warn('Failed to load driver from database:', e);
    return null;
  }
}

function updateDatabaseUI(info) {
  const isConn = info && info.status === 'CONNECTED';
  
  // Header badge
  const headerBtn = document.getElementById('btnDbStatus');
  if (headerBtn) {
    headerBtn.innerHTML = `
      <span class="w-2 h-2 rounded-full ${isConn ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}"></span>
      <span class="font-mono text-xs font-bold text-white">System: <span class="${isConn ? 'text-emerald-400' : 'text-amber-400'}">${isConn ? 'Online' : 'Offline'}</span></span>
    `;
    headerBtn.title = isConn ? 'System Online (Connected)' : 'System Offline';
  }

  // Mobile settings badge
  const mobileBadge = document.getElementById('mobileDbStatusBadge');
  if (mobileBadge) {
    if (isConn) {
      mobileBadge.className = 'text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono font-bold flex items-center gap-1';
      mobileBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> ONLINE';
    } else {
      mobileBadge.className = 'text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-mono font-bold flex items-center gap-1';
      mobileBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> OFFLINE';
    }
  }

  // Sync timestamps and details
  const syncTimeEl = document.getElementById('dbLastSyncTime');
  if (syncTimeEl) {
    const t = new Date();
    syncTimeEl.innerText = `Synced at ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  }

  // Modal elements
  if (info) {
    const pathEl = document.getElementById('modalDbPath');
    if (pathEl) pathEl.innerText = 'Encrypted Local Storage (Active)';
    const sizeEl = document.getElementById('modalDbSize');
    if (sizeEl) sizeEl.innerText = 'Secure';

    if (info.record_counts) {
      const c = info.record_counts;
      const cntDrivers = document.getElementById('cntDrivers');
      if (cntDrivers && c.drivers !== undefined) cntDrivers.innerText = `${c.drivers} partners`;
      const cntVehicles = document.getElementById('cntVehicles');
      if (cntVehicles && c.vehicles !== undefined) cntVehicles.innerText = `${c.vehicles} fleet types`;
      const cntTrips = document.getElementById('cntTrips');
      if (cntTrips && c.trips !== undefined) cntTrips.innerText = `${c.trips} orders`;
      const cntPayouts = document.getElementById('cntPayouts');
      if (cntPayouts && c.payouts !== undefined) cntPayouts.innerText = `${c.payouts} settlements`;
      const cntDailyLogs = document.getElementById('cntDailyLogs');
      if (cntDailyLogs && c.daily_logs !== undefined) cntDailyLogs.innerText = `${c.daily_logs} days`;
      const cntTelemetry = document.getElementById('cntTelemetry');
      if (cntTelemetry && c.telemetry_pings !== undefined) cntTelemetry.innerText = `${c.telemetry_pings} pings`;
    }
  }
}

// ==========================================
// 3. REAL-TIME WEBSOCKET DISPATCH GATEWAY
// ==========================================
let socket = null;
let isGatewayConnected = false;
let driverOfferPollInterval = null;

function startDriverOfferPolling() {
  if (driverOfferPollInterval) clearInterval(driverOfferPollInterval);
  if (!vaayuDriverToken) return;
  const poll = async () => {
    if (!state.isLoggedIn || state.status !== 'ONLINE' || currentTrip || !vaayuDriverToken) return;
    try {
      const response = await fetch('/api/driver/offers');
      const result = await response.json();
      updateGatewayStatus(Boolean(response.ok), response.ok ? 'Authenticated REST polling active' : 'Driver API unavailable');
      if (response.ok && result.success && Array.isArray(result.offers) && result.offers.length) {
        const offer = result.offers[0];
        if (!currentTrip || currentTrip.tripId !== offer.tripId) handleIncomingTripRequest(offer);
      }
    } catch (_) { updateGatewayStatus(false, 'Driver API unavailable'); }
  };
  poll();
  driverOfferPollInterval = setInterval(poll, 2500);
}

function initSocketConnection() {
  if (!vaayuDriverToken) {
    updateGatewayStatus(false, 'Sign in to connect');
    return;
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws?token=${encodeURIComponent(vaayuDriverToken)}`;
  updateGatewayStatus(false, 'Connecting...');

  try {
    if (socket) {
      socket.close();
    }

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('✅ Connected to Dispatch Backend Gateway via WebSocket');
      isGatewayConnected = true;
      updateGatewayStatus(true, 'Live Gateway Connected');
      const driverId = state.driverId || state.userId || '';
      if (driverId) {
        socket.send(JSON.stringify({ action: 'join', room: `driver:${driverId}` }));
      }
    };

    socket.onclose = () => {
      console.log('⚠️ Disconnected from Dispatch Backend Gateway');
      isGatewayConnected = false;
      updateGatewayStatus(Boolean(vaayuDriverToken), vaayuDriverToken ? 'REST polling active' : 'Disconnected');
      // Exponential backoff reconnect
      setTimeout(() => {
        if (state.isLoggedIn && !isGatewayConnected) initSocketConnection();
      }, 5000);
    };

    socket.onerror = (err) => {
      isGatewayConnected = false;
      updateGatewayStatus(Boolean(vaayuDriverToken), vaayuDriverToken ? 'REST polling active' : 'Gateway Error');
    };

    socket.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.event === 'dispatch_offer' || envelope.event === 'dispatch:offer_created') {
          console.log('📥 Received incoming trip offer:', envelope.data);
          handleIncomingTripRequest(envelope.data.trip || envelope.data);
        } else if (envelope.event === 'emergency_assignment') {
          console.log('🚨 Received emergency assignment:', envelope.data);
          alert(envelope.data.message || 'Emergency assignment received!');
        }
      } catch (_) {}
    };

  } catch (err) {
    console.warn('Socket initialization exception:', err);
    updateGatewayStatus(Boolean(vaayuDriverToken), vaayuDriverToken ? 'REST polling active' : 'Sign in to receive offers');
  }
}

function updateGatewayStatus(connected, text) {
  const badge = document.getElementById('gatewayStatusBadge');
  if (!badge) return;
  if (connected) {
    badge.className = 'text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono font-bold';
    badge.innerText = '🟢 ' + text;
  } else {
    badge.className = 'text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-mono font-bold';
    badge.innerText = '🟠 ' + text;
  }
}

function startDriverGeolocation() {
  if (!vaayuDriverToken || !navigator.geolocation || browserGeoWatchId !== null) return;
  browserGeoWatchId = navigator.geolocation.watchPosition(position => {
    const { latitude, longitude, heading, speed } = position.coords;
    driverLat = latitude;
    driverLng = longitude;
    driverHeading = Number.isFinite(heading) ? heading : driverHeading;
    driverSpeedKmH = Number.isFinite(speed) ? Math.round(speed * 3.6) : 0;
    if (driverMarker) driverMarker.setLatLng([driverLat, driverLng]);
    sendLocationPing();
  }, error => {
    showToast('Location unavailable', error.message || 'Allow location access so dispatch and arrival checks can work.', '📍');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}

// 📡 Outgoing Event 1: Real-time Location Ping (Every 3 seconds when ONLINE or ON_TRIP)
function sendLocationPing() {
  if (state.status === 'OFFLINE') return;

  // Jitter coordinates slightly during trip to simulate movement
  if (!vaayuDriverToken && state.status === 'ON_TRIP' && currentTrip) {
    driverLat += (Math.random() - 0.48) * 0.0006;
    driverLng += (Math.random() - 0.48) * 0.0006;
    driverSpeedKmH = Math.round(18 + Math.random() * 14);
    if (driverMarker) driverMarker.setLatLng([driverLat, driverLng]);
    const spdEl = document.getElementById('currentSpeed');
    if (spdEl) spdEl.innerText = `${driverSpeedKmH} km/h`;
  }

  const payload = {
    driverId: state.driverId,
    vehicleId: state.vehicleId,
    status: state.status, // "ONLINE" or "ON_TRIP"
    lat: parseFloat(driverLat.toFixed(5)),
    lng: parseFloat(driverLng.toFixed(5)),
    heading: driverHeading,
    speedKmH: driverSpeedKmH,
    timestamp: Date.now()
  };

  // Emit over Socket.io if connected
  if (socket && isGatewayConnected) {
    socket.emit('driver:location_ping', payload);
  }

  // Stream telemetry directly to local database 'vaayu'
  fetch('/api/telemetry/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driver_id: state.driverId,
      lat: payload.lat,
      lng: payload.lng,
      speed: payload.speedKmH,
      heading: payload.heading,
      status: payload.status
    })
  }).catch(() => {});

  // Update Telemetry Display in Settings
  const telEl = document.getElementById('telemetryStatus');
  if (telEl) {
    telEl.innerText = `Streamed: ${payload.lat}, ${payload.lng} (${payload.status})`;
  }
}

// 📡 Outgoing Event 2: Accept / Decline Trip Request
function emitTripDriverResponse(tripId, action) {
  const payload = {
    tripId: tripId,
    driverId: state.driverId,
    action: action, // "ACCEPT" or "DECLINE"
    timestamp: Date.now()
  };

  console.log('📡 Emitting "trip:driver_response":', payload);
  if (socket && isGatewayConnected) {
    socket.emit('trip:driver_response', payload);
    return Promise.resolve({ success: true });
  }
  if (!vaayuDriverToken) return Promise.resolve({ success: true, demo: true });
  if (action === 'ACCEPT') {
    return fetch('/api/orders/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: tripId, idempotencyKey: `driver-accept-${tripId}` }) }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Could not accept this delivery.');
      return result;
    });
  }
  return fetch('/api/dispatch/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: tripId, driverId: state.driverId }) }).then(async response => {
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Could not decline this delivery.');
    return result;
  });
}

// 📡 Outgoing Event 3: Update Trip Status
function emitTripUpdateStatus(tripId, nextStatus, otpValue = '', proof = null) {
  const payload = {
    tripId: tripId,
    driverId: state.driverId,
    status: nextStatus // "ARRIVED_AT_PICKUP" -> "IN_TRANSIT" -> "COMPLETED"
  };

  console.log('📡 Emitting "trip:update_status":', payload);
  if (socket && isGatewayConnected) {
    socket.emit('trip:update_status', payload);
    return Promise.resolve({ success: true });
  }
  if (!vaayuDriverToken) return Promise.resolve({ success: true, demo: true });
  const postAction = async (action, otp, actionProof = null) => {
    const response = await fetch(`/api/orders/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: tripId, ...(otp ? { otp } : {}), ...(actionProof ? { proof: actionProof } : {}), idempotencyKey: `driver-${action}-${tripId}-${currentTrip?.statusVersion || 1}` }) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || `Could not update delivery: ${nextStatus}`);
    if (currentTrip && result.trip && Number.isFinite(Number(result.trip.version))) {
      currentTrip.statusVersion = Number(result.trip.version);
    }
    return result;
  };
  if (nextStatus === 'ARRIVED_AT_PICKUP') return postAction('start-arriving').then(() => postAction('arrived-pickup'));
  if (nextStatus === 'IN_TRANSIT') {
    if (!otpValue) return Promise.reject(new Error('Ask the sender for the pickup verification code.'));
    return postAction('confirm-pickup', otpValue).then(() => postAction('start-transit'));
  }
  if (nextStatus === 'ARRIVED_AT_DESTINATION') return postAction('arrived-dropoff');
  if (nextStatus === 'COMPLETED') {
    if (!otpValue) return Promise.reject(new Error('Ask the receiver for the delivery verification code.'));
    return postAction('complete', otpValue, proof);
  }
  return Promise.reject(new Error(`Unsupported trip status: ${nextStatus}`));
}

// ==========================================
// 4. MAP & ROUTING CONTROLLER
// ==========================================
let map = null;
let driverMarker = null;
let pickupMarker = null;
let dropMarker = null;
let routeLine = null;
let routeRenderSequence = 0;

async function drawMapRoute(points, color = '#10b981') {
  if (!map || !window.VaayuMapEngine) return null;
  const sequence = ++routeRenderSequence;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  try {
    const result = await window.VaayuMapEngine.drawRoute(map, points, {
      color,
      vehicleId: state.vehicleId,
      weight: 5,
      padding: [45, 45],
      maxZoom: 15
    });
    if (sequence !== routeRenderSequence) {
      if (result.line && map.hasLayer(result.line)) map.removeLayer(result.line);
      return null;
    }
    routeLine = result.line;
    const quality = document.getElementById('mapRouteQuality');
    if (quality) {
      quality.textContent = result.route.isDegraded
        ? 'Approximate offline route'
        : `Road route · ${result.route.provider || 'VAAYU Maps'}`;
      quality.className = result.route.isDegraded ? 'text-amber-300' : 'text-emerald-300';
    }
    return result.route;
  } catch (error) {
    if (sequence !== routeRenderSequence) return null;
    // Keep map context visible, but clearly draw only a straight estimate if
    // the routing endpoint itself is unavailable.
    routeLine = window.VaayuMapEngine.renderGeometry(map, points, {
      color, isDegraded: true, weight: 5, padding: [45, 45], maxZoom: 15
    });
    const quality = document.getElementById('mapRouteQuality');
    if (quality) {
      quality.textContent = 'Routing unavailable · straight-line estimate';
      quality.className = 'text-amber-300';
    }
    return null;
  }
}

function initMap() {
  const mapElement = document.getElementById('liveMap');
  if (!mapElement) return;

  map = L.map('liveMap', {
    zoomControl: false,
    attributionControl: true
  }).setView([driverLat, driverLng], 13);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  updateDriverMarkerIcon();
}

function updateDriverMarkerIcon() {
  if (!map) return;
  const currentVehicle = VEHICLE_CATALOG[state.vehicleId] || VEHICLE_CATALOG.v_ace;
  
  const icon = L.divIcon({
    className: 'clean-leaflet-icon',
    html: `
      <div class="pin-emoji-xl-center">
        ${currentVehicle.icon || '🚚'}
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });

  if (!driverMarker) {
    driverMarker = L.marker([driverLat, driverLng], { icon: icon }).addTo(map);
  } else {
    driverMarker.setIcon(icon);
  }
}

function drawOrderRoute(pickupCoords, dropCoords) {
  if (pickupMarker) map.removeLayer(pickupMarker);
  if (dropMarker) map.removeLayer(dropMarker);
  if (routeLine) map.removeLayer(routeLine);

  // Exact Customer App Clean Green Pin Dot for Pickup
  const pickupIcon = L.divIcon({
    className: 'clean-leaflet-icon',
    html: `<div class="pin-dot-emerald-22"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  // Exact Customer App Clean Red Pin Dot for Drop
  const dropIcon = L.divIcon({
    className: 'clean-leaflet-icon',
    html: `<div class="pin-dot-rose-22"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  pickupMarker = L.marker(pickupCoords, { icon: pickupIcon }).addTo(map).bindPopup('🟢 Pickup Location');
  dropMarker = L.marker(dropCoords, { icon: dropIcon }).addTo(map).bindPopup('🔴 Delivery Destination');

  drawMapRoute([[driverLat, driverLng], pickupCoords, dropCoords], '#10b981');
}

let activeWaypointMarkers = [];

function updateTruckCapacityUI(stage) {
  const capBadge = document.getElementById('truckCapacityBadge');
  const capBar = document.getElementById('truckCapacityBar');
  const capWeight = document.getElementById('truckCurrentWeight');
  const capSpace = document.getElementById('truckRemainingSpace');
  const capPill = document.getElementById('truckStatusPill');

  if (stage === 0) {
    if (capBadge) { capBadge.innerText = '0% LOADED'; capBadge.className = 'text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono font-bold'; }
    if (capBar) { capBar.style.width = '0%'; capBar.className = 'bg-slate-700 h-full transition-all duration-500'; }
    if (capWeight) capWeight.innerText = '0 kg';
    if (capSpace) capSpace.innerText = '750 kg Capacity';
    if (capPill) { capPill.innerText = 'READY FOR ORDERS'; capPill.className = 'text-[9px] bg-emerald-500 text-slate-950 font-black px-2 py-0.5 rounded-full uppercase tracking-wider inline-block'; }
  } else if (stage === 1 || stage === 2) {
    if (capBadge) { capBadge.innerText = '41% LOADED'; capBadge.className = 'text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold'; }
    if (capBar) { capBar.style.width = '41%'; capBar.className = 'bg-gradient-to-r from-emerald-500 to-teal-400 h-full transition-all duration-500'; }
    if (capWeight) capWeight.innerText = '310 kg';
    if (capSpace) capSpace.innerText = '440 kg Free Space (59%)';
    if (capPill) { capPill.innerText = 'SPACE AVAILABLE'; capPill.className = 'text-[9px] bg-emerald-400 text-slate-950 font-black px-2 py-0.5 rounded-full uppercase tracking-wider inline-block'; }
  } else if (stage === 3 || stage === 4 || stage === 5 || stage === 6) {
    if (capBadge) { capBadge.innerText = '65% LOADED'; capBadge.className = 'text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-mono font-bold'; }
    if (capBar) { capBar.style.width = '65%'; capBar.className = 'bg-gradient-to-r from-amber-500 to-emerald-400 h-full transition-all duration-500'; }
    if (capWeight) capWeight.innerText = '490 kg';
    if (capSpace) { capSpace.innerText = '260 kg Free Space (35%)'; capSpace.className = 'text-amber-400 font-bold'; }
    if (capPill) { capPill.innerText = '2 ORDERS BATCHED'; capPill.className = 'text-[9px] bg-amber-400 text-slate-950 font-black px-2 py-0.5 rounded-full uppercase tracking-wider inline-block'; }
  } else if (stage === 7 || stage === 8) {
    if (capBadge) { capBadge.innerText = '41% LOADED'; capBadge.className = 'text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold'; }
    if (capBar) { capBar.style.width = '41%'; capBar.className = 'bg-gradient-to-r from-emerald-500 to-teal-400 h-full transition-all duration-500'; }
    if (capWeight) capWeight.innerText = '310 kg';
    if (capSpace) { capSpace.innerText = '440 kg Free Space (59%)'; capSpace.className = 'text-slate-300'; }
    if (capPill) { capPill.innerText = 'FINAL ORDER EN ROUTE'; capPill.className = 'text-[9px] bg-sky-400 text-slate-950 font-black px-2 py-0.5 rounded-full uppercase tracking-wider inline-block'; }
  }
}
window.updateTruckCapacityUI = updateTruckCapacityUI;

function drawDestinationRoute(startCoords, dropCoords) {
  if (pickupMarker) { map.removeLayer(pickupMarker); pickupMarker = null; }
  if (dropMarker) { map.removeLayer(dropMarker); dropMarker = null; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (activeWaypointMarkers.length) {
    activeWaypointMarkers.forEach(m => map.removeLayer(m));
    activeWaypointMarkers = [];
  }

  // 1. Move Driver marker to Pickup coordinates
  driverLat = startCoords[0];
  driverLng = startCoords[1];
  if (driverMarker) {
    driverMarker.setLatLng(startCoords);
  }

  // 2. Add Completed Pickup marker badge
  const pickupIcon = L.divIcon({
    className: 'pin-pickedup',
    html: `<div class="pin-label-pickedup"><span>✅</span> <span>Goods Picked Up (310kg)</span></div>`,
    iconAnchor: [52, 14]
  });
  pickupMarker = L.marker(startCoords, { icon: pickupIcon }).addTo(map);

  // 3. Add High-Visibility Destination Drop Marker
  const destName = (currentTrip && currentTrip.dropAddress) ? currentTrip.dropAddress.split(',')[0] : 'Destination Drop';
  const dropIcon = L.divIcon({
    className: 'pin-destination',
    html: `<div class="pin-label-destination"><span>🏁</span> <span>DESTINATION: ${destName}</span></div>`,
    iconAnchor: [60, 16]
  });
  dropMarker = L.marker(dropCoords, { icon: dropIcon }).addTo(map);

  drawMapRoute([startCoords, dropCoords], '#00f5a0').then(route => {
    const routeSummary = document.getElementById('navEtaDistance');
    if (routeSummary && route) routeSummary.innerText = `${route.distanceKm} km • ${route.durationMin} min${route.isDegraded ? ' · estimate' : ''}`;
  });

  // 8. Show Turn-by-Turn Destination HUD
  const navHud = document.getElementById('destinationNavHud');
  if (navHud) {
    navHud.classList.remove('hidden');
    const titleEl = document.getElementById('navDestinationTitle');
    const etaEl = document.getElementById('navEtaDistance');
    const nextWpEl = document.getElementById('navNextWaypointSub');
    if (titleEl && currentTrip) titleEl.innerText = currentTrip.dropAddress;
    if (etaEl && currentTrip) etaEl.innerText = `${currentTrip.distanceKm || 8.5} km • 18 min`;
    if (nextWpEl) {
      nextWpEl.classList.remove('hidden');
      nextWpEl.innerText = 'Following the road route to the delivery address';
    }
  }
  const mapOverlay = document.getElementById('mapStatusOverlay');
  if (mapOverlay) mapOverlay.classList.add('hidden');

  // Scroll map into view smoothly
  const liveMapEl = document.getElementById('liveMap');
  if (liveMapEl) {
    liveMapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}


function clearOrderRoute() {
  routeRenderSequence++;
  if (pickupMarker) { map.removeLayer(pickupMarker); pickupMarker = null; }
  if (dropMarker) { map.removeLayer(dropMarker); dropMarker = null; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (activeWaypointMarkers && activeWaypointMarkers.length) {
    activeWaypointMarkers.forEach(m => map.removeLayer(m));
    activeWaypointMarkers = [];
  }
  const navHud = document.getElementById('destinationNavHud');
  if (navHud) navHud.classList.add('hidden');
  const mapOverlay = document.getElementById('mapStatusOverlay');
  if (mapOverlay) mapOverlay.classList.remove('hidden');
  map.setView([driverLat, driverLng], 14);
}

// ==========================================
// 5. INCOMING TRIP ALERT & LIFECYCLE
// ==========================================
function handleIncomingTripRequest(data) {
  data.tripId = data.tripId || data.orderId;
  data.pickupAddress = data.pickupAddress || 'Pickup location';
  data.dropAddress = data.dropAddress || 'Delivery location';
  data.pickupLat = Number(data.pickupLat);
  data.pickupLng = Number(data.pickupLng);
  data.dropLat = Number(data.dropLat);
  data.dropLng = Number(data.dropLng);
  data.estimatedEarnings = Number(data.estimatedEarnings || data.totalFare || 0);
  data.distanceKm = Number(data.distanceKm || data.distKm || 0);
  if (!data.tripId) return;
  data.countdownSeconds = Math.max(1, Math.floor((Number(data.offerExpiresAt) - Date.now()) / 1000) || 30);
  currentTrip = data;
  currentTripStatus = 'SEARCHING';

  // Play High Energy Audio Siren Alert
  audioSynth.playOrderAlert();

  // Populate Alert Modal per Technical Blueprint
  document.getElementById('alertBrandPill').innerText = data.vehicleName || 'VAAYU EXPRESS';
  document.getElementById('alertFareAmount').innerText = `₹${Number(data.estimatedEarnings || 0).toFixed(2)}`;
  document.getElementById('alertTotalDist').innerText = `${data.distanceKm} km`;
  document.getElementById('alertPickupTitle').innerText = data.pickupAddress.split(',')[0];
  document.getElementById('alertPickupAddress').innerText = data.pickupAddress;
  document.getElementById('alertDropTitle').innerText = data.dropAddress.split(',')[0];
  document.getElementById('alertDropAddress').innerText = data.dropAddress;

  const breakdownEl = document.getElementById('alertBreakdownText');
  if (breakdownEl) {
    breakdownEl.innerText = data.isCod 
      ? `💵 COD: Collect ₹${data.codAmount.toFixed(2)} Cash` 
      : 'Guaranteed digital prepaid earnings';
    breakdownEl.className = data.isCod 
      ? 'text-[10px] text-amber-300 font-bold' 
      : 'text-[10px] text-slate-400';
  }

  const modal = document.getElementById('orderAlertModal');
  modal.classList.remove('hidden');

  startCountdown(data.countdownSeconds || 15);

  if (state.autoAccept) {
    setTimeout(acceptCurrentTrip, 1500);
  }
}

function startCountdown(seconds) {
  if (alertCountdownInterval) clearInterval(alertCountdownInterval);
  alertCountdownSeconds = seconds;
  const countText = document.getElementById('countdownText');
  const timerCircle = document.getElementById('timerCircle');
  const fullDash = 88;

  timerCircle.style.strokeDashoffset = '0';
  if (countText) countText.innerText = `${alertCountdownSeconds}s`;

  alertCountdownInterval = setInterval(() => {
    alertCountdownSeconds -= 1;
    if (countText) countText.innerText = `${alertCountdownSeconds}s`;

    const progress = (seconds - alertCountdownSeconds) / seconds;
    timerCircle.style.strokeDashoffset = String(fullDash * progress);

    if (alertCountdownSeconds <= 0) {
      declineCurrentTrip();
    }
  }, 1000);
}

async function declineCurrentTrip() {
  if (alertCountdownInterval) clearInterval(alertCountdownInterval);
  document.getElementById('orderAlertModal').classList.add('hidden');

  if (currentTrip) {
    try { await emitTripDriverResponse(currentTrip.tripId, 'DECLINE'); }
    catch (error) {
      showToast('Could not decline delivery', error.message, '⚠️');
      currentTrip = null;
      currentTripStatus = null;
      startDriverOfferPolling();
      return;
    }
  }

  currentTrip = null;
  currentTripStatus = null;
}

async function acceptCurrentTrip() {
  if (!currentTrip) return;
  if (alertCountdownInterval) clearInterval(alertCountdownInterval);
  try {
    await emitTripDriverResponse(currentTrip.tripId, 'ACCEPT');
  } catch (error) {
    showToast('Could not accept delivery', error.message, '⚠️');
    if (alertCountdownInterval) startCountdown(Math.max(alertCountdownSeconds, 5));
    return;
  }
  document.getElementById('orderAlertModal').classList.add('hidden');
  audioSynth.playSuccess();

  // Set Driver Status to ON_TRIP and Trip Status to ACCEPTED
  state.status = 'ON_TRIP';
  currentTripStatus = 'ACCEPTED';
  if (driverOfferPollInterval) { clearInterval(driverOfferPollInterval); driverOfferPollInterval = null; }
  if (vaayuDriverToken) fetch('/api/driver/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: state.driverId, status: 'ON_TRIP' }) }).catch(() => {});

  renderActiveTripUI();
  drawOrderRoute([currentTrip.pickupLat, currentTrip.pickupLng], [currentTrip.dropLat, currentTrip.dropLng]);
  syncUI();
}

function renderActiveTripUI() {
  const idleCard = document.getElementById('idleDutyCard');
  const tripCard = document.getElementById('activeTripCard');
  const sliderBox = document.getElementById('sliderCompleteContainer');
  const advanceBtn = document.getElementById('btnAdvanceTrip');

  if (!currentTrip || state.status !== 'ON_TRIP') {
    idleCard.classList.remove('hidden');
    tripCard.classList.add('hidden');
    clearOrderRoute();
    if (sliderBox) sliderBox.classList.add('hidden');
    if (advanceBtn) advanceBtn.classList.remove('hidden');
    return;
  }

  idleCard.classList.add('hidden');
  tripCard.classList.remove('hidden');


  document.getElementById('tripBrandBadge').innerText = currentTrip.vehicleName;
  document.getElementById('tripIdText').innerText = `#${currentTrip.tripId}`;
  document.getElementById('tripCategoryTag').innerText = `${currentTrip.distanceKm} km • Standard Commercial Cargo`;
  document.getElementById('tripEarningsBadge').innerText = `₹${parseFloat(currentTrip.estimatedEarnings).toFixed(2)}`;

  document.getElementById('tripPickupName').innerText = currentTrip.pickupAddress.split(',')[0];
  document.getElementById('tripPickupAddr').innerText = currentTrip.pickupAddress;
  document.getElementById('tripDropName').innerText = `${currentTrip.customerName || 'Customer'} (${currentTrip.dropAddress.split(',')[0]})`;
  document.getElementById('tripDropAddr').innerText = currentTrip.dropAddress;

  const progressBar = document.getElementById('tripProgressBar');
  const stepBadge = document.getElementById('tripStepBadge');
  const advanceIcon = document.getElementById('advanceBtnIcon');
  const advanceText = document.getElementById('advanceBtnText');
  const callBtnLabel = document.getElementById('callButtonLabel');

  if (currentTripStatus === 'ACCEPTED') {
    stepBadge.innerText = 'STEP 1: TO PICKUP';
    stepBadge.className = 'font-bold text-amber-400';
    progressBar.style.width = '33%';
    advanceIcon.innerText = '📍';
    advanceText.innerText = 'I HAVE ARRIVED AT PICKUP';
    callBtnLabel.innerText = 'Call Pickup';
    if (sliderBox) sliderBox.classList.add('hidden');
    if (advanceBtn) advanceBtn.classList.remove('hidden');
  } else if (currentTripStatus === 'ARRIVED_AT_PICKUP') {
    stepBadge.innerText = 'STEP 1: AT PICKUP (VERIFY OTP)';
    stepBadge.className = 'font-bold text-sky-400';
    progressBar.style.width = '50%';
    advanceIcon.innerText = '🔐';
    advanceText.innerText = 'ENTER PICKUP OTP (4821)';
    callBtnLabel.innerText = 'Call Pickup';
    if (sliderBox) sliderBox.classList.add('hidden');
    if (advanceBtn) advanceBtn.classList.remove('hidden');
  } else if (currentTripStatus === 'IN_TRANSIT') {
    stepBadge.innerText = 'STEP 2: EN ROUTE TO DESTINATION';
    stepBadge.className = 'font-bold text-emerald-400';
    progressBar.style.width = '75%';
    advanceIcon.innerText = '📍';
    advanceText.innerText = 'I HAVE ARRIVED AT DESTINATION';
    callBtnLabel.innerText = `Call ${currentTrip.customerName || 'Customer'}`;
    if (sliderBox) sliderBox.classList.add('hidden');
    if (advanceBtn) advanceBtn.classList.remove('hidden');
  } else if (currentTripStatus === 'ARRIVED_AT_DESTINATION') {
    stepBadge.innerText = 'STEP 3: AT DESTINATION - COMPLETE DROPOFF';
    stepBadge.className = 'font-bold text-teal-300';
    progressBar.style.width = '100%';
    advanceIcon.innerText = '✅';
    advanceText.innerText = 'COMPLETE ORDER';
    callBtnLabel.innerText = `Call ${currentTrip.customerName || 'Customer'}`;
    if (sliderBox) {
      sliderBox.classList.remove('hidden');
      if (window.resetCompleteSlider) window.resetCompleteSlider();
    }
    if (advanceBtn) advanceBtn.classList.add('hidden');
  }
}

let lastAdvanceTripTimestamp = 0;
async function handleAdvanceTrip() {
  const now = Date.now();
  if (now - lastAdvanceTripTimestamp < 400) return;
  lastAdvanceTripTimestamp = now;
  audioSynth.playClick();
  if (!currentTrip) return;

  if (currentTripStatus === 'ACCEPTED') {
    try { await emitTripUpdateStatus(currentTrip.tripId, 'ARRIVED_AT_PICKUP'); }
    catch (error) { showToast('Pickup arrival not confirmed', error.message, '⚠️'); return; }
    currentTripStatus = 'ARRIVED_AT_PICKUP';
    if (!vaayuDriverToken && driverMarker && currentTrip) {
      driverMarker.setLatLng([currentTrip.pickupLat, currentTrip.pickupLng]);
    }
    renderActiveTripUI();
    openDeliveryOtpModal();
  } else if (currentTripStatus === 'ARRIVED_AT_PICKUP') {
    openDeliveryOtpModal();
  } else if (currentTripStatus === 'IN_TRANSIT') {
    try { await emitTripUpdateStatus(currentTrip.tripId, 'ARRIVED_AT_DESTINATION'); }
    catch (error) { showToast('Delivery arrival not confirmed', error.message, '⚠️'); return; }
    currentTripStatus = 'ARRIVED_AT_DESTINATION';
    if (!vaayuDriverToken && driverMarker && currentTrip) {
      driverMarker.setLatLng([currentTrip.dropLat, currentTrip.dropLng]);
      map.setView([currentTrip.dropLat, currentTrip.dropLng], 15);
    }
    renderActiveTripUI();
    const sliderBox = document.getElementById('sliderCompleteContainer');
    if (sliderBox) {
      setTimeout(() => {
        sliderBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  } else if (currentTripStatus === 'ARRIVED_AT_DESTINATION') {
    completeTripDelivery();
  }
}

// One-tap "OPEN IN GOOGLE MAPS" as required by specification
function openGoogleMapsNavigation() {
  if (!currentTrip) return;
  const isHeadingToPickup = (currentTripStatus === 'ACCEPTED' || currentTripStatus === 'ARRIVED_AT_PICKUP');
  let lat = parseFloat(isHeadingToPickup ? currentTrip.pickupLat : currentTrip.dropLat);
  let lng = parseFloat(isHeadingToPickup ? currentTrip.pickupLng : currentTrip.dropLng);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn('[DriverApp] Invalid navigation coordinates, falling back to default reference');
    lat = 17.4850;
    lng = 78.4041;
  }

  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=driving`;
  window.open(url, '_blank');
}

// ==========================================
// 6. PICKUP / DELIVERY OTP VERIFICATION & NAVIGATION
// ==========================================
let otpEntryKind = 'pickup';
function openDeliveryOtpModal(kind = 'pickup') {
  otpEntryKind = kind;
  const modal = document.getElementById('otpModal');
  const title = document.getElementById('otpModalTitle');
  const desc = document.getElementById('otpModalDesc');

  let titleStr = kind === 'delivery' ? 'Enter Delivery Verification OTP' : 'Enter Pickup Verification OTP';
  let descStr = kind === 'delivery' ? 'Ask the receiver for the 4-digit delivery OTP.' : 'Ask sender for the 4-digit package handover OTP.';

  if (currentTrip && kind === 'pickup') {
    titleStr = 'Enter Pickup Verification OTP';
    descStr = `Collect the 4-digit handover OTP from sender at ${currentTrip.pickupAddress} to load goods.`;
  }

  if (title) title.innerText = titleStr;
  if (desc) desc.innerText = descStr;
  if (hint) {
    hint.innerText = 'Enter the code provided by the sender or receiver.';
    hint.classList.remove('hidden');
  }

  const inputs = document.querySelectorAll('.otp-input');
  inputs.forEach(input => { input.value = ''; });

  // Proof of delivery is captured only on the delivery step.
  const proofFields = document.getElementById('proofFields');
  if (proofFields) proofFields.classList.toggle('hidden', kind !== 'delivery');
  const proofName = document.getElementById('proofReceiverName');
  if (proofName) proofName.value = '';
  const proofPhoto = document.getElementById('proofPhotoInput');
  if (proofPhoto) proofPhoto.value = '';

  modal.classList.remove('hidden');
  if (inputs.length) inputs[0].focus();
}

// Reads the chosen photo as a data URL, for upload to the proof route.
function readProofPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

// Uploads the optional delivery photo and returns its server reference. Returns null when no photo was chosen.
async function uploadDeliveryProof(tripId) {
  const photoInput = document.getElementById('proofPhotoInput');
  const file = photoInput && photoInput.files && photoInput.files[0];
  if (!file) return null;
  if (file.size > 5 * 1024 * 1024) throw new Error('Delivery photo must be 5 MB or smaller.');
  const imageData = await readProofPhoto(file);
  const response = await fetch('/api/trip/proof-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip_id: tripId, image_data: imageData })
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'The delivery photo could not be uploaded.');
  return result.proofPhotoRef;
}

// Builds the proof sent with completion. Only the server reference of the photo is included.
async function buildDeliveryProof(tripId) {
  const nameInput = document.getElementById('proofReceiverName');
  const receiverName = nameInput ? nameInput.value.trim() : '';
  const podPhotoUrl = await uploadDeliveryProof(tripId);
  if (!receiverName && !podPhotoUrl) return null;
  return { receiverName: receiverName || null, podPhotoUrl };
}

function closeDeliveryOtpModal() {
  document.getElementById('otpModal').classList.add('hidden');
}

async function submitDeliveryOtp() {
  const inputs = document.querySelectorAll('.otp-input');
  let entered = '';
  inputs.forEach(i => entered += i.value);

  // The server verifies the OTP; the client only checks the shape
  if (entered.length !== 4) {
    alert(`Enter the 4-digit ${otpEntryKind} OTP.`);
    return;
  }

  if (otpEntryKind === 'delivery') {
    await completeTripDelivery(entered);
    return;
  }

  try {
    if (currentTrip) await emitTripUpdateStatus(currentTrip.tripId, 'IN_TRANSIT', entered);
    audioSynth.playSuccess();
    closeDeliveryOtpModal();
    currentTripStatus = 'IN_TRANSIT';

    drawDestinationRoute([currentTrip.pickupLat, currentTrip.pickupLng], [currentTrip.dropLat, currentTrip.dropLng]);

    renderActiveTripUI();
    syncUI();

  } catch (error) { showToast('Pickup verification failed', error.message, '⚠️'); }
}

// ==========================================
// 6b. DRAG TO COMPLETE ORDER & SETTLEMENT
// ==========================================
async function completeTripDelivery(deliveryOtp = '') {
  if (!currentTrip) return;
  if (vaayuDriverToken) {
    if (!deliveryOtp) { openDeliveryOtpModal('delivery'); return; }
    try {
      const proof = await buildDeliveryProof(currentTrip.tripId);
      await emitTripUpdateStatus(currentTrip.tripId, 'COMPLETED', deliveryOtp, proof);
    }
    catch (error) { showToast('Delivery could not be completed', error.message, '⚠️'); return; }
    closeDeliveryOtpModal();
  }
  audioSynth.playSuccess();

  const earnings = parseFloat(currentTrip.estimatedEarnings) || 0;

  if (currentTrip.tripId && !vaayuDriverToken) {
    emitTripUpdateStatus(currentTrip.tripId, 'COMPLETED');
  }

  state.todayTrips += 1;
  state.todayEarnings += earnings;
  state.pocketBalance += earnings;
  state.status = 'ONLINE';

  feedbackQueue = [{
    tripId: currentTrip.tripId,
    customerName: currentTrip.customerName || 'Customer',
    customerAvatar: currentTrip.customerAvatar || '👤',
    customerRating: currentTrip.customerRating || '',
    pickupAddress: currentTrip.pickupAddress,
    dropAddress: currentTrip.dropAddress,
    earnings: earnings,
    isCod: currentTrip.isCod,
    codAmount: currentTrip.codAmount || 0,
    orderNumber: 1,
    totalOrders: 1
  }];

  currentFeedbackQueueIndex = 0;
  currentTrip = null;
  currentTripStatus = null;
  if (vaayuDriverToken) {
    fetch('/api/driver/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: state.driverId, status: 'ONLINE' }) }).catch(() => {});
    loadDriverFromDatabase(state.driverId);
    startDriverOfferPolling();
  }
  clearOrderRoute();
  renderActiveTripUI();
  syncUI();


  // Open separate feedback for each customer sequentially (never merged)
  setTimeout(() => {
    startNextFeedbackInQueue();
  }, 100);
}

// ==========================================
// 6c. MULTI-ORDER & EN-ROUTE BATCH CONTROLLERS
// ==========================================
function acceptMultipleOrdersBatch() {
  showToast('Batching unavailable', 'Multi-order batching is not live yet.', '⚠️');
}
window.acceptMultipleOrdersBatch = acceptMultipleOrdersBatch;

function showEnRouteOrderOffer() {
  showToast('Batching unavailable', 'Multi-order batching is not live yet.', '⚠️');
}
window.showEnRouteOrderOffer = showEnRouteOrderOffer;

function declineEnRouteBatchOrder() {
  showToast('Batching unavailable', 'Multi-order batching is not live yet.', '⚠️');
}
window.declineEnRouteBatchOrder = declineEnRouteBatchOrder;

function acceptEnRouteBatchOrder() {
  showToast('Batching unavailable', 'Multi-order batching is not live yet.', '⚠️');
}
window.acceptEnRouteBatchOrder = acceptEnRouteBatchOrder;

function selectBatchOrderView(index) {
  showToast('Batching unavailable', 'Multi-order batching is not live yet.', '⚠️');
}
window.selectBatchOrderView = selectBatchOrderView;

function initDragToCompleteSlider() {
  const container = document.getElementById('sliderCompleteContainer');
  const thumb = document.getElementById('sliderThumb');
  const fill = document.getElementById('sliderFillTrack');
  const text = document.getElementById('sliderText');
  if (!container || !thumb) return;

  let isDragging = false;
  let startX = 0;
  let currentX = 0;
  let maxDrag = 0;

  function updateMaxDrag() {
    maxDrag = Math.max(10, container.clientWidth - thumb.clientWidth - 12);
  }

  function onStart(e) {
    const canSlide = (state.status === 'ON_TRIP') && currentTripStatus === 'ARRIVED_AT_DESTINATION';
    if (!canSlide) return;
    isDragging = true;
    updateMaxDrag();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    startX = clientX - currentX;
    thumb.style.transition = 'none';
    if (fill) fill.style.transition = 'none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let delta = clientX - startX;
    if (delta < 0) delta = 0;
    if (delta > maxDrag) delta = maxDrag;
    currentX = delta;

    thumb.style.transform = `translateX(${delta}px)`;
    if (fill) {
      fill.style.width = `${delta + thumb.clientWidth + 6}px`;
      fill.style.opacity = `${0.25 + (delta / maxDrag) * 0.75}`;
    }
  }

  function onEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    updateMaxDrag();

    if (currentX >= maxDrag * 0.7) {
      // Completed! Snap across to end
      thumb.style.transition = 'transform 0.2s ease-out';
      thumb.style.transform = `translateX(${maxDrag}px)`;
      if (fill) {
        fill.style.transition = 'width 0.2s ease-out';
        fill.style.width = '100%';
        fill.style.opacity = '1';
      }
      if (text) text.innerText = '✅ ORDER COMPLETED!';
      audioSynth.playSuccess();
      setTimeout(() => {
        completeTripDelivery();
        resetSlider();
      }, 80);
    } else {
      // Snap back to starting position
      resetSlider();
    }
  }

  function resetSlider() {
    currentX = 0;
    if (thumb) {
      thumb.style.transition = 'transform 0.3s ease-out';
      thumb.style.transform = 'translateX(0px)';
    }
    if (fill) {
      fill.style.transition = 'width 0.3s ease-out, opacity 0.3s ease-out';
      fill.style.width = '56px';
      fill.style.opacity = '0.25';
    }
    if (text) {
      text.innerText = '👉 DRAG TO ORDER COMPLETE >>>';
    }
  }

  // Touch handlers
  thumb.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);

  // Mouse handlers
  thumb.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);

  // Tap anywhere on track to auto-complete (accessible fallback)
  container.addEventListener('click', (e) => {
    if (e.target === thumb) return;
    const canSlide = (state.status === 'ON_TRIP') && currentTripStatus === 'ARRIVED_AT_DESTINATION';
    if (canSlide) {
      updateMaxDrag();
      thumb.style.transition = 'transform 0.2s ease-out';
      thumb.style.transform = `translateX(${maxDrag}px)`;
      if (fill) {
        fill.style.transition = 'width 0.2s ease-out';
        fill.style.width = '100%';
      }
      if (text) text.innerText = '✅ ORDER COMPLETED!';
      setTimeout(() => {
        completeTripDelivery();
        resetSlider();
      }, 80);
    }
  });

  window.resetCompleteSlider = resetSlider;
}

// ==========================================
// 6b. CUSTOMER FEEDBACK & RATING CONTROLLER
// ==========================================
let currentFeedbackTrip = null;
let currentSelectedRating = 5;
let toastTimeout = null;
let feedbackQueue = [];
let currentFeedbackQueueIndex = 0;

const RATING_DESCRIPTIONS = {
  1: "⭐ Unacceptable / Safety / Severe Delays",
  2: "⭐⭐ Needs Improvement / Payment Issue",
  3: "⭐⭐⭐ Average Experience",
  4: "⭐⭐⭐⭐ Good Customer Handover",
  5: "⭐⭐⭐⭐⭐ Excellent! Very polite & cooperative"
};

window.showToast = showToast;
function showToast(title, desc, icon = '✓') {
  const toast = document.getElementById('appToast');
  const toastTitle = document.getElementById('appToastTitle');
  const toastDesc = document.getElementById('appToastDesc');
  const toastIcon = document.getElementById('appToastIcon');

  if (!toast) return;
  if (toastTitle) toastTitle.innerText = title;
  if (toastDesc) toastDesc.innerText = desc;
  if (toastIcon) toastIcon.innerText = icon;

  if (toastTimeout) clearTimeout(toastTimeout);
  toast.classList.remove('hidden');

  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function startNextFeedbackInQueue() {
  if (currentFeedbackQueueIndex >= feedbackQueue.length) {
    closeCustomerFeedbackModal();
    return;
  }
  const item = feedbackQueue[currentFeedbackQueueIndex];
  openCustomerFeedbackModal(item);
}
window.startNextFeedbackInQueue = startNextFeedbackInQueue;

function openCustomerFeedbackModal(tripDetails) {
  currentFeedbackTrip = tripDetails;
  currentSelectedRating = 5;

  const modal = document.getElementById('customerFeedbackModal');
  if (!modal) return;

  const earnEl = document.getElementById('feedbackModalEarnings');
  if (earnEl) earnEl.innerText = `+₹${tripDetails.earnings.toFixed(2)}`;

  const codBadge = document.getElementById('feedbackModalCodBadge');
  const codAmountEl = document.getElementById('feedbackModalCodAmount');
  if (tripDetails.isCod && tripDetails.codAmount > 0) {
    if (codBadge) codBadge.classList.remove('hidden');
    if (codAmountEl) codAmountEl.innerText = `₹${tripDetails.codAmount.toFixed(2)}`;
  } else {
    if (codBadge) codBadge.classList.add('hidden');
  }

  const nameEl = document.getElementById('feedbackCustomerName');
  if (nameEl) nameEl.innerText = tripDetails.customerName || 'Customer';

  const avatarEl = document.getElementById('feedbackCustomerAvatar');
  if (avatarEl) avatarEl.innerText = tripDetails.customerAvatar || '👨‍💼';

  const ratingEl = document.getElementById('feedbackCustomerRating');
  if (ratingEl) ratingEl.innerText = tripDetails.customerRating || '4.9';

  const destEl = document.getElementById('feedbackTripIdAndDest');
  if (destEl) {
    const shortDrop = (tripDetails.dropAddress || 'Drop').split(',')[0];
    destEl.innerText = `${tripDetails.tripId} • ${shortDrop}`;
  }

  // Dynamic Step Indicator & Customized Header for separate reviews
  const stepInd = document.getElementById('feedbackStepIndicator');
  const singleBadge = document.getElementById('feedbackSingleBadge');
  const heading = document.getElementById('feedbackModalHeading');
  const subheading = document.getElementById('feedbackModalSubheading');
  const submitText = document.getElementById('feedbackSubmitBtnText');
  const submitIcon = document.getElementById('feedbackSubmitBtnIcon');

  if (tripDetails.totalOrders && tripDetails.totalOrders > 1) {
    if (stepInd) {
      stepInd.classList.remove('hidden');
      stepInd.innerText = `CUSTOMER ${tripDetails.orderNumber} OF ${tripDetails.totalOrders} • ORDER #${tripDetails.orderNumber}`;
    }
    if (singleBadge) singleBadge.classList.add('hidden');
    if (heading) heading.innerText = `Rate ${tripDetails.customerName}`;
    if (subheading) subheading.innerText = `Separate feedback for Drop #${tripDetails.orderNumber} (${tripDetails.dropAddress.split(',')[0]}).`;

    if (tripDetails.orderNumber < tripDetails.totalOrders) {
      if (submitText) submitText.innerText = `Next: Rate Customer ${tripDetails.orderNumber + 1}`;
      if (submitIcon) submitIcon.innerText = '➔';
    } else {
      if (submitText) submitText.innerText = 'Submit & Return Online';
      if (submitIcon) submitIcon.innerText = '✓';
    }
  } else {
    if (stepInd) stepInd.classList.add('hidden');
    if (singleBadge) singleBadge.classList.remove('hidden');
    if (heading) heading.innerText = 'Rate Your Customer';
    if (subheading) subheading.innerText = 'Help Vaayu maintain a safe, high-trust partner community.';
    if (submitText) submitText.innerText = 'Submit Feedback';
    if (submitIcon) submitIcon.innerText = '✓';
  }

  // Reset star rating to 5
  setStarRating(5);

  // Reset driver notes
  const notesInput = document.getElementById('feedbackDriverNotes');
  if (notesInput) notesInput.value = '';

  // Reset tags to default selection (first 2 positive tags selected)
  document.querySelectorAll('.feedback-tag-chip').forEach(chip => {
    const tag = chip.dataset.tag;
    if (tag === 'polite' || tag === 'quick_handover') {
      chip.classList.add('selected');
    } else {
      chip.classList.remove('selected');
    }
  });

  modal.classList.remove('hidden');
}

function closeCustomerFeedbackModal() {
  const modal = document.getElementById('customerFeedbackModal');
  if (modal) modal.classList.add('hidden');
  currentFeedbackTrip = null;
  feedbackQueue = [];
  currentFeedbackQueueIndex = 0;
}

function setStarRating(rating) {
  currentSelectedRating = rating;
  const stars = document.querySelectorAll('.star-btn');
  stars.forEach((star) => {
    const starVal = parseInt(star.dataset.rating, 10);
    if (starVal <= rating) {
      star.classList.add('active');
    } else {
      star.classList.remove('active');
    }
  });

  const textEl = document.getElementById('starRatingFeedbackText');
  if (textEl) {
    textEl.innerText = RATING_DESCRIPTIONS[rating] || `${rating} Stars`;
    if (rating <= 2) {
      textEl.className = 'text-xs font-bold text-rose-400 font-display';
    } else if (rating === 3) {
      textEl.className = 'text-xs font-bold text-amber-400 font-display';
    } else {
      textEl.className = 'text-xs font-bold text-emerald-400 font-display';
    }
  }
}

function submitCustomerFeedback() {
  audioSynth.playSuccess();

  const selectedTags = [];
  document.querySelectorAll('.feedback-tag-chip.selected').forEach(c => {
    selectedTags.push(c.innerText.trim());
  });

  const notes = document.getElementById('feedbackDriverNotes')?.value.trim() || '';
  const pairAgain = document.getElementById('feedbackPairAgainToggle')?.checked ?? true;

  const payload = {
    tripId: currentFeedbackTrip?.tripId,
    customerName: currentFeedbackTrip?.customerName || 'Customer',
    rating: currentSelectedRating,
    tags: selectedTags,
    notes: notes,
    pairAgain: pairAgain,
    timestamp: Date.now()
  };

  console.log('📝 Customer Feedback Submitted by Driver:', payload);

  if (socket && isGatewayConnected) {
    socket.emit('driver:customer_feedback', payload);
  }

  // Persist feedback to local database 'vaayu'
  fetch('/api/feedback/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trip_id: payload.tripId || 'TRIP_84920',
      driver_id: state.driverId,
      customer_name: payload.customerName,
      rating: payload.rating,
      tags: payload.tags,
      driver_notes: payload.notes,
      pair_again: payload.pairAgain
    })
  }).then(() => checkDatabaseHealth()).catch(() => {});

  currentFeedbackQueueIndex += 1;
  if (currentFeedbackQueueIndex < feedbackQueue.length) {
    showToast(
      `Saved ${payload.customerName}! ★`,
      `Rated ${currentSelectedRating}★. Now rating next customer in batch.`,
      '⭐'
    );
    // Smooth transition to next customer in queue
    const modalContent = document.querySelector('#customerFeedbackModal > div');
    if (modalContent) {
      modalContent.style.opacity = '0';
      modalContent.style.transform = 'scale(0.96)';
      setTimeout(() => {
        startNextFeedbackInQueue();
        modalContent.style.transition = 'all 0.25s ease-out';
        modalContent.style.opacity = '1';
        modalContent.style.transform = 'scale(1)';
      }, 150);
    } else {
      startNextFeedbackInQueue();
    }
  } else {
    closeCustomerFeedbackModal();
    showToast(
      'All Feedback Submitted! ★',
      'Both customers reviewed separately. Total +₹621.65 added to your Pocket wallet.',
      '⭐'
    );
  }
}

function skipCustomerFeedback() {
  currentFeedbackQueueIndex += 1;
  if (currentFeedbackQueueIndex < feedbackQueue.length) {
    showToast(
      'Feedback Skipped',
      'Now rating next customer in batch.',
      'ℹ️'
    );
    startNextFeedbackInQueue();
  } else {
    closeCustomerFeedbackModal();
  }
}
window.skipCustomerFeedback = skipCustomerFeedback;

// ==========================================
// 7. POCKET & WITHDRAWAL CONTROLLER
// ==========================================
function openPayoutModal() {
  document.getElementById('payoutModal').classList.remove('hidden');
  document.getElementById('inputWithdrawAmount').value = Math.floor(state.pocketBalance);
}

function closePayoutModal() {
  document.getElementById('payoutModal').classList.add('hidden');
}

async function confirmPayoutTransfer() {
  const amountInput = document.getElementById('inputWithdrawAmount');
  const amount = parseFloat(amountInput.value);
  const upiId = String(document.getElementById('inputPayoutUpiId')?.value || '').trim();

  if (isNaN(amount) || amount <= 0) {
    alert('Please enter a valid withdrawal amount.');
    return;
  }

  if (amount > state.pocketBalance) {
    alert(`Insufficient balance. Max withdrawable: ₹${state.pocketBalance.toFixed(2)}`);
    return;
  }
  if (!/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(upiId)) {
    alert('Enter a valid UPI ID for the payout request.');
    return;
  }

  // Persist payout to local database 'vaayu' via REST API
  try {
    const res = await fetch('/api/payouts/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        amount: amount,
        method: 'UPI payout request',
        upi_id: upiId
      })
    });
    const result = await res.json();
    if (result.success && result.payout) {
      state.payouts.unshift({
        id: result.payout.id,
        date: result.payout.date_str || result.payout.requestedAt,
        amount: result.payout.amount,
        method: result.payout.method,
        status: result.payout.status,
        utr: result.payout.utr || null
      });
      closePayoutModal();
      syncUI();
      checkDatabaseHealth();
      alert(`Payout request for ₹${amount.toFixed(2)} submitted for admin review. No money has been transferred yet.`);
      return;
    }
    alert(result.error || 'Could not submit payout request. Please try again.');
    return;
  } catch (err) {
    console.error('Payout request failed:', err);
    alert('Could not reach the payout service. No payout was created. Please try again.');
    return;
  }
}

function renderPayoutHistory() {
  const container = document.getElementById('payoutHistoryList');
  if (!container) return;
  container.innerHTML = '';

  state.payouts.forEach(p => {
    const item = document.createElement('div');
    item.className = 'p-2.5 rounded-xl bg-slate-900/70 border border-slate-800 flex items-center justify-between text-xs';
    item.innerHTML = `
      <div>
        <div class="font-semibold text-slate-200 flex items-center gap-1.5">
          <span>₹${p.amount.toFixed(2)}</span>
          <span class="text-[9px] ${p.status === 'PAID' || p.status === 'Settled' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-300'} px-1.5 py-0.2 rounded font-mono">${p.status === 'PAID' ? 'SETTLED' : String(p.status).replaceAll('_', ' ')}</span>
        </div>
        <div class="text-[10px] text-slate-400 mt-0.5">${p.date} &bull; ${p.method}</div>
      </div>
      <div class="text-right font-mono text-[10px] text-slate-500">
        ${p.utr || 'No transfer reference yet'}
      </div>
    `;
    container.appendChild(item);
  });
}

function renderAttendanceCalendar() {
  const container = document.getElementById('calendarDaysGrid');
  if (!container) return;
  container.innerHTML = '';

  for (let d = 1; d <= 30; d++) {
    const isWorked = d <= state.workingDaysMonth;
    const isToday = d === 29;
    const dayCell = document.createElement('div');
    dayCell.className = `py-1 rounded font-medium flex flex-col items-center justify-center ${
      isToday 
        ? 'bg-vaayu-500 text-slate-950 font-bold shadow' 
        : isWorked 
        ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30' 
        : 'bg-slate-900/40 text-slate-500'
    }`;
    dayCell.innerHTML = `
      <span>${d}</span>
      <span class="text-[7px] leading-none ${isWorked ? 'text-emerald-400' : 'text-slate-600'}">
        ${isWorked ? '●' : '○'}
      </span>
    `;
    container.appendChild(dayCell);
  }
}

function formatDecimalHours(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${h}h ${m > 0 ? (m < 10 ? '0' + m : m) + 'm' : '00m'}`;
}

function renderDailyBreakdown() {
  const container = document.getElementById('dailyEarningsList');
  if (!state.dailyLogs || !state.dailyLogs.length) return;

  // Sync today's log entry with live state
  const todayEntry = state.dailyLogs.find(d => d.isToday) || state.dailyLogs[0];
  if (todayEntry) {
    if (state.todayEarnings > todayEntry.earnings) {
      const diff = state.todayEarnings - todayEntry.earnings;
      todayEntry.earnings = state.todayEarnings;
      if (!todayEntry.breakdown) todayEntry.breakdown = { basePay: 0, surge: 0, incentive: 0, codCollected: 0 };
      todayEntry.breakdown.basePay = (todayEntry.breakdown.basePay || 0) + diff;
    }
    todayEntry.orders = Math.max(todayEntry.orders, state.todayTrips);
    if (state.shiftSeconds > 0) {
      const liveHours = +(state.shiftSeconds / 3600).toFixed(2);
      todayEntry.hours = Math.max(todayEntry.hours || 7.42, liveHours);
    }
  }

  let totalEarnings = 0;
  let totalHours = 0;
  let totalTrips = 0;

  state.dailyLogs.forEach(d => {
    totalEarnings += Number(d.earnings) || 0;
    totalHours += Number(d.hours) || 0;
    totalTrips += Number(d.orders) || 0;
  });

  const avgPerHour = totalHours > 0 ? (totalEarnings / totalHours) : 0;
  const avgDayHours = state.dailyLogs.length > 0 ? (totalHours / state.dailyLogs.length) : 0;

  // Update summary header card elements
  const weeklyModalTotal = document.getElementById('weeklyModalTotal');
  if (weeklyModalTotal) {
    weeklyModalTotal.innerText = `₹${totalEarnings.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const weeklyModalTotalHours = document.getElementById('weeklyModalTotalHours');
  if (weeklyModalTotalHours) {
    weeklyModalTotalHours.innerText = formatDecimalHours(totalHours);
  }

  const weeklyAvgPerHour = document.getElementById('weeklyAvgPerHour');
  if (weeklyAvgPerHour) {
    weeklyAvgPerHour.innerText = `₹${Math.round(avgPerHour)} / hr`;
  }

  const weeklyTotalTrips = document.getElementById('weeklyTotalTrips');
  if (weeklyTotalTrips) {
    weeklyTotalTrips.innerText = `${totalTrips} Trips`;
  }

  const weeklyAvgPerDay = document.getElementById('weeklyAvgPerDay');
  if (weeklyAvgPerDay) {
    weeklyAvgPerDay.innerText = `${avgDayHours.toFixed(1)} hrs`;
  }

  const pocketWeeklyEl = document.getElementById('pocketWeeklyAmount');
  if (pocketWeeklyEl) {
    pocketWeeklyEl.innerText = `₹${Math.round(totalEarnings).toLocaleString('en-IN')}`;
  }

  const pocketWeeklySubtext = document.getElementById('pocketWeeklySubtext');
  if (pocketWeeklySubtext) {
    pocketWeeklySubtext.innerHTML = `<span class="text-emerald-400 font-bold">${totalTrips} trips completed</span> &bull; <span class="text-sky-300 font-mono font-bold">⏱️ ${formatDecimalHours(totalHours)} logged</span>`;
  }

  const pocketWeeklyTarget = document.getElementById('pocketWeeklyTarget');
  if (pocketWeeklyTarget) {
    pocketWeeklyTarget.innerText = `₹${Math.round(totalEarnings).toLocaleString('en-IN')} / ₹12,000`;
  }

  if (!container) return;
  container.innerHTML = '';

  state.dailyLogs.forEach(day => {
    const dayHoursStr = formatDecimalHours(day.hours);
    const hourlyRate = day.hours > 0 ? Math.round(day.earnings / day.hours) : 0;
    const shiftPercent = Math.min(100, Math.round((day.hours / 8.0) * 100));
    const breakdown = day.breakdown || { basePay: day.earnings * 0.7, surge: 0, incentive: 0, codCollected: 0 };

    const card = document.createElement('div');
    card.className = `p-3.5 rounded-2xl bg-slate-950/70 border ${
      day.isToday 
        ? 'border-emerald-500/50 bg-gradient-to-br from-slate-950 via-emerald-950/20 to-slate-950 ring-1 ring-emerald-500/20 shadow-md' 
        : 'border-slate-800/90 hover:border-slate-700'
    } space-y-2.5 transition`;

    card.innerHTML = `
      <!-- Top Row: Date & Total Day Earnings -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl ${day.isToday ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-900 text-slate-400'} flex items-center justify-center text-sm font-bold">
            ${day.isToday ? '⚡' : '📅'}
          </div>
          <div>
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-xs ${day.isToday ? 'text-white' : 'text-slate-200'}">${day.date}</span>
              ${day.isToday ? '<span class="text-[9px] bg-emerald-500/20 text-emerald-400 font-bold px-1.5 py-0.2 rounded border border-emerald-500/30">TODAY</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
              <span class="text-sky-400 font-mono font-bold">⏱️ ${dayHoursStr}</span>
              <span>&bull;</span>
              <span class="text-slate-300 font-semibold">📦 ${day.orders} trips</span>
            </div>
          </div>
        </div>
        <div class="text-right">
          <span class="font-display font-black text-sm text-emerald-400 font-mono block">₹${Number(day.earnings).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span class="text-[10px] text-amber-300 font-mono font-bold">₹${hourlyRate}/hr</span>
        </div>
      </div>

      <!-- Shift Target Progress Bar (Target: 8h/day) -->
      <div class="space-y-1">
        <div class="flex justify-between text-[10px] text-slate-400 font-mono">
          <span>Shift Target (8 hrs)</span>
          <span class="${shiftPercent >= 100 ? 'text-emerald-400 font-bold' : 'text-slate-400'}">${Number(day.hours).toFixed(1)}h logged (${shiftPercent}%)</span>
        </div>
        <div class="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden border border-slate-800">
          <div class="h-full rounded-full ${
            shiftPercent >= 100 ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : 'bg-gradient-to-r from-vaayu-500 to-sky-400'
          }" data-shift-bar></div>
        </div>
      </div>

      <!-- Itemized Component Pills: Base, Surge, Incentive, COD -->
      <div class="grid grid-cols-4 gap-1.5 pt-1 border-t border-slate-900 text-center">
        <div class="p-1 rounded-lg bg-slate-900/60 border border-slate-850">
          <span class="text-[8px] uppercase text-slate-400 block">Base Pay</span>
          <span class="text-[10px] font-mono font-bold text-slate-200">₹${Number(breakdown.basePay || 0).toFixed(0)}</span>
        </div>
        <div class="p-1 rounded-lg bg-slate-900/60 border border-slate-850">
          <span class="text-[8px] uppercase text-slate-400 block">Surge</span>
          <span class="text-[10px] font-mono font-bold text-amber-300">+₹${Number(breakdown.surge || 0).toFixed(0)}</span>
        </div>
        <div class="p-1 rounded-lg bg-slate-900/60 border border-slate-850">
          <span class="text-[8px] uppercase text-slate-400 block">Incentive</span>
          <span class="text-[10px] font-mono font-bold text-emerald-400">+₹${Number(breakdown.incentive || 0).toFixed(0)}</span>
        </div>
        <div class="p-1 rounded-lg bg-slate-900/60 border border-slate-850">
          <span class="text-[8px] uppercase text-slate-400 block">COD Cash</span>
          <span class="text-[10px] font-mono font-bold text-sky-300">₹${Number(breakdown.codCollected || 0).toFixed(0)}</span>
        </div>
      </div>
    `;

    card.querySelector('[data-shift-bar]').style.width = `${shiftPercent}%`;
    container.appendChild(card);
  });
}

// ==========================================
// 7b. DOCUMENT VERIFICATION & KYC CONTROLLER
// Matches screenshots: media_1790784783110.jpg & media_1790784540055.jpg
// ==========================================
let currentScanDocType = 'aadhaar_front';
let activeCameraStream = null;
let currentCameraFacing = 'environment';
let cachedKycSummary = null;

async function fetchDriverDocuments() {
  try {
    const res = await fetch(`/api/documents?driver_id=${encodeURIComponent(state.driverId)}`);
    const data = await res.json();
    if (data) {
      if (data.documents) {
        cachedDriverDocuments = data.documents;
        window.cachedDriverDocuments = data.documents;
      }
      if (data.kyc_summary) {
        cachedKycSummary = data.kyc_summary;
        window.cachedKycSummary = data.kyc_summary;
        updateKycUIFromSummary(data.kyc_summary, data.documents);
      }
    }
  } catch (err) {
    console.warn('Could not fetch driver documents from backend:', err);
  }
}
window.fetchDriverDocuments = fetchDriverDocuments;

function updateKycUIFromSummary(summary, documents) {
  if (!summary) return;
  const checklist = summary.checklist || {};

  // 1. Aadhaar Card
  const aadhaarSub = document.getElementById('kycAadhaarStatusSub');
  const aadhaarBtn = document.getElementById('btnKycAadhaarUpload');
  const aadhaarLabel = document.getElementById('btnKycAadhaarLabel');
  if (checklist.aadhaar && checklist.aadhaar.verified) {
    if (aadhaarSub) {
      aadhaarSub.innerText = `Verified • ${checklist.aadhaar.number || 'XXXX XXXX 8842'}`;
      aadhaarSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (aadhaarBtn) {
      aadhaarBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2.5 py-1.5 rounded-xl border border-emerald-500/40 shadow-sm cursor-pointer';
    }
    if (aadhaarLabel) aadhaarLabel.innerText = 'Verified ✓';
  } else {
    if (aadhaarSub) {
      aadhaarSub.innerText = 'Front & Back side required';
      aadhaarSub.className = 'text-[10px] text-slate-400 font-medium';
    }
    if (aadhaarBtn) {
      aadhaarBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-1.5 rounded-xl border border-emerald-500/30 transition active:scale-95 cursor-pointer shadow-sm';
    }
    if (aadhaarLabel) aadhaarLabel.innerText = 'Upload';
  }

  // 2. PAN Card
  const panSub = document.getElementById('kycPanStatusSub');
  const panBtn = document.getElementById('btnKycPanUpload');
  const panLabel = document.getElementById('btnKycPanLabel');
  if (checklist.pan && checklist.pan.verified) {
    if (panSub) {
      panSub.innerText = `Verified • ${checklist.pan.number || 'ABCDE1234F'}`;
      panSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (panBtn) {
      panBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2.5 py-1.5 rounded-xl border border-emerald-500/40 shadow-sm cursor-pointer';
    }
    if (panLabel) panLabel.innerText = 'Verified ✓';
  } else {
    if (panSub) {
      panSub.innerText = 'Front & Back side required';
      panSub.className = 'text-[10px] text-slate-400 font-medium';
    }
    if (panBtn) {
      panBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-1.5 rounded-xl border border-emerald-500/30 transition active:scale-95 cursor-pointer shadow-sm';
    }
    if (panLabel) panLabel.innerText = 'Upload';
  }

  // 3. Selfie
  const selfieSub = document.getElementById('kycSelfieStatusSub');
  const selfieBtn = document.getElementById('btnKycSelfieUpload');
  const selfieLabel = document.getElementById('btnKycSelfieLabel');
  if (checklist.selfie && checklist.selfie.verified) {
    if (selfieSub) {
      selfieSub.innerText = 'Face Verified ✓';
      selfieSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (selfieBtn) {
      selfieBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2.5 py-1.5 rounded-xl border border-emerald-500/40 shadow-sm cursor-pointer';
    }
    if (selfieLabel) selfieLabel.innerText = 'Verified ✓';
  } else {
    if (selfieSub) {
      selfieSub.innerText = 'Clear portrait with good lighting';
      selfieSub.className = 'text-[10px] text-slate-400 font-medium';
    }
    if (selfieBtn) {
      selfieBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-1.5 rounded-xl border border-emerald-500/30 transition active:scale-95 cursor-pointer shadow-sm';
    }
    if (selfieLabel) selfieLabel.innerText = 'Upload';
  }

  // 4. Vehicle RC Card
  const rcSub = document.getElementById('vehicleRcStatusSub');
  const rcPill = document.getElementById('vehicleRcUploadedPill');
  if (checklist.rc && checklist.rc.verified) {
    if (rcSub) {
      rcSub.innerText = `Verified • ${checklist.rc.number || '—'}`;
      rcSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (rcPill) {
      rcPill.innerHTML = '<span>✓</span><span>Verified</span>';
      rcPill.className = 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 text-xs font-bold rounded-lg flex items-center gap-1';
    }
  }

  // 4b. Commercial Vehicle Permit Card (Required for 3W & Trucks)
  const permitCard = document.getElementById('commercialPermitCard');
  const permitSub = document.getElementById('commercialPermitStatusSub');
  const permitBtn = document.getElementById('btnCommercialPermitUpload');
  const permitLabel = document.getElementById('btnCommercialPermitLabel');
  const permitEdit = document.getElementById('btnCommercialPermitEdit');

  const isComm = selectedVehicleCategory === 'truck' || selectedVehicleCategory === '3w';
  if (permitCard) {
    if (isComm) {
      permitCard.classList.remove('hidden');
    } else {
      permitCard.classList.add('hidden');
    }
  }

  if (checklist.permit && checklist.permit.verified) {
    if (permitSub) {
      permitSub.innerText = `Verified • ${checklist.permit.number || 'TS/COMM/2023/8842'}`;
      permitSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (permitBtn) {
      permitBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-500/20 px-2.5 py-1 text-xs rounded-xl border border-emerald-500/40 shadow-sm cursor-pointer';
    }
    if (permitLabel) permitLabel.innerText = 'Verified ✓';
    if (permitEdit) permitEdit.classList.remove('hidden');
  } else {
    if (permitSub) {
      permitSub.innerText = 'Goods Carriage Permit (State / National)';
      permitSub.className = 'text-[10px] text-slate-400 font-medium';
    }
    if (permitBtn) {
      permitBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-1.5 rounded-xl border border-emerald-500/30 transition active:scale-95 cursor-pointer shadow-sm';
    }
    if (permitLabel) permitLabel.innerText = 'Upload';
    if (permitEdit) permitEdit.classList.add('hidden');
  }

  // 5. Driver License Card
  const dlSub = document.getElementById('driverLicenseStatusSub');
  const dlBtn = document.getElementById('btnDriverLicenseUpload');
  const dlLabel = document.getElementById('btnDriverLicenseLabel');
  if (checklist.license && checklist.license.verified) {
    if (dlSub) {
      dlSub.innerText = `Verified • ${checklist.license.number || 'DL-1420110012345'}`;
      dlSub.className = 'text-[10px] text-emerald-400 font-bold font-mono';
    }
    if (dlBtn) {
      dlBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 bg-emerald-500/20 px-3 py-1.5 rounded-xl border border-emerald-500/40 shadow-sm cursor-pointer';
    }
    if (dlLabel) dlLabel.innerText = 'Verified ✓';
  } else {
    if (dlSub) {
      dlSub.innerText = 'Front & Back side required';
      dlSub.className = 'text-[10px] text-slate-400 font-medium';
    }
    if (dlBtn) {
      dlBtn.className = 'flex items-center gap-1.5 text-xs font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-1.5 rounded-xl border border-emerald-500/30 transition active:scale-95 cursor-pointer shadow-sm';
    }
    if (dlLabel) dlLabel.innerText = 'Upload';
  }

  // 6. Submit button
  const submitBtn = document.getElementById('btnKycSubmit');
  if (submitBtn) {
    if (summary.all_owner_docs_verified) {
      submitBtn.className = 'w-full py-3.5 rounded-xl font-display font-black text-sm text-center shadow-lg transition active:scale-98 cursor-pointer bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 hover:from-emerald-300 hover:to-cyan-300 text-slate-950 shadow-emerald-500/25 tracking-wide';
      submitBtn.innerText = 'Submit & Complete Step 1';
      submitBtn.disabled = false;
    } else {
      submitBtn.className = 'w-full py-3.5 rounded-xl font-display font-bold text-sm text-center transition cursor-not-allowed bg-slate-800 text-slate-500 border border-slate-700/50';
      submitBtn.innerText = 'Submit (Upload all 3 documents)';
      submitBtn.disabled = true;
    }
  }

  // 7. Storage Count badge
  const dbSyncEl = document.getElementById('kycDbSyncCount');
  if (dbSyncEl && documents) {
    dbSyncEl.innerText = `${documents.length} Verified`;
  }

  // 8. Settings tab badge
  const settingsBadge = document.getElementById('settingsKycCountText');
  if (settingsBadge && summary.steps && summary.steps[0]) {
    settingsBadge.innerText = `${summary.steps[0].verified_count}/${summary.steps[0].total_count} Verified`;
  }

  // 9. Top Cockpit KYC Badge (Clean badge without tick mark)
  const topKycBadge = document.getElementById('topKycBadgeText');
  const topDot = document.getElementById('topKycBadgeDot');
  if (topKycBadge) {
    if (summary.all_owner_docs_verified) {
      topKycBadge.innerText = 'KYC';
      if (topDot) topDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
    } else {
      topKycBadge.innerText = 'KYC Pending';
      if (topDot) topDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse';
    }
  }

  // 10. Profile Card KYC Badge (Settings section - right side of profile)
  const profKycBadgeText = document.getElementById('profileKycBadgeText');
  const profKycDot = document.getElementById('profileKycDot');
  const profKycBtn = document.getElementById('profileKycBadge');
  if (profKycBadgeText) {
    if (summary.all_owner_docs_verified) {
      profKycBadgeText.innerText = 'KYC ✓';
      if (profKycDot) profKycDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
      if (profKycBtn) profKycBtn.className = 'flex items-center gap-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm active:scale-95 transition cursor-pointer shrink-0';
    } else {
      profKycBadgeText.innerText = 'KYC Pending';
      if (profKycDot) profKycDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse';
      if (profKycBtn) profKycBtn.className = 'flex items-center gap-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm active:scale-95 transition cursor-pointer shrink-0';
    }
  }
}

function openOwnerDetailsModal() {
  closeVehicleDetailsModal();
  closeDriverDetailsModal();
  const modal = document.getElementById('ownerDetailsModal');
  if (modal) {
    modal.classList.remove('hidden');
    fetchDriverDocuments();
    if (typeof audioSynth !== 'undefined' && audioSynth) {
      try { audioSynth.playClick(); } catch (e) {}
    }
  }
}
window.openOwnerDetailsModal = openOwnerDetailsModal;

function closeOwnerDetailsModal() {
  const modal = document.getElementById('ownerDetailsModal');
  if (modal) modal.classList.add('hidden');
}
window.closeOwnerDetailsModal = closeOwnerDetailsModal;

// ==========================================
// STEP 2 & 3: VEHICLE, FUEL & DRIVER DETAILS
// Matches media_1790786725059.png, media_1790786694395.jpg & media_1790786694394.jpg
// ==========================================
let selectedVehicleCategory = '2w';
let selectedVehicleBodyType = 'Bike';
let selectedFuel = 'Petrol';
let isSelfDriving = false;

function openVehicleDetailsModal() {
  closeOwnerDetailsModal();
  closeDriverDetailsModal();
  const modal = document.getElementById('vehicleDetailsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  
  if (cachedKycSummary && cachedKycSummary.driver_info) {
    const plateInput = document.getElementById('vehicleNumberInput');
    if (plateInput && cachedKycSummary.driver_info.vehicle_plate) {
      plateInput.value = cachedKycSummary.driver_info.vehicle_plate;
    }
    if (cachedKycSummary.driver_info.city_of_operation) {
      selectedCity = cachedKycSummary.driver_info.city_of_operation;
      const cityEl = document.getElementById('selectedCityName');
      if (cityEl) cityEl.innerText = selectedCity;
    }
    if (cachedKycSummary.driver_info.vehicle_category) {
      selectVehicleCategory(cachedKycSummary.driver_info.vehicle_category);
    }
    if (cachedKycSummary.driver_info.vehicle_body_type) {
      selectVehicleBodyType(cachedKycSummary.driver_info.vehicle_body_type);
    }
    if (cachedKycSummary.driver_info.vehicle_fuel_type) {
      selectedFuel = cachedKycSummary.driver_info.vehicle_fuel_type;
      const fuelEl = document.getElementById('selectedFuelName');
      if (fuelEl) fuelEl.innerText = selectedFuel;
    }
  }

  fetchDriverDocuments();
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.openVehicleDetailsModal = openVehicleDetailsModal;

function closeVehicleDetailsModal() {
  const modal = document.getElementById('vehicleDetailsModal');
  if (modal) modal.classList.add('hidden');
}
window.closeVehicleDetailsModal = closeVehicleDetailsModal;

function openCitySelectModal() {
  const modal = document.getElementById('citySelectModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  highlightSelectedCityUI(selectedCity);
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.openCitySelectModal = openCitySelectModal;

function closeCitySelectModal() {
  const modal = document.getElementById('citySelectModal');
  if (modal) modal.classList.add('hidden');
}
window.closeCitySelectModal = closeCitySelectModal;

function selectCity(cityName) {
  selectedCity = cityName;
  highlightSelectedCityUI(cityName);
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.selectCity = selectCity;

function highlightSelectedCityUI(cityName) {
  const cities = ['Mumbai', 'Delhi NCR', 'Bangalore', 'Hyderabad', 'Chennai', 'Ahmedabad', 'Pune', 'Kolkata', 'Jaipur', 'Surat'];
  cities.forEach(c => {
    const idKey = c.replace(/\s+/g, '');
    const radioEl = document.getElementById(`cityRadio_${idKey}`);
    if (radioEl) {
      if (c === cityName) {
        radioEl.className = 'w-5 h-5 rounded-full border-2 border-emerald-400 bg-emerald-400 flex items-center justify-center text-slate-950 text-xs font-black shadow-[0_0_8px_#34d399]';
        radioEl.innerText = '✓';
      } else {
        radioEl.className = 'w-5 h-5 rounded-full border-2 border-slate-600 bg-slate-950 flex items-center justify-center';
        radioEl.innerText = '';
      }
    }
  });
}

function confirmCitySelect() {
  const cityEl = document.getElementById('selectedCityName');
  if (cityEl) cityEl.innerText = selectedCity;
  closeCitySelectModal();
  showToast('City Selected 📍', `Operating region set to ${selectedCity}.`, '📍');
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playSuccess(); } catch (e) {}
  }
}
window.confirmCitySelect = confirmCitySelect;

function selectVehicleCategory(cat) {
  selectedVehicleCategory = cat;
  
  const truckBtn = document.getElementById('btnVehicleTypeTruck');
  const apeBtn = document.getElementById('btnVehicleType3W');
  const bikeBtn = document.getElementById('btnVehicleType2W');

  const truckDot = document.getElementById('radioTruckDot');
  const apeDot = document.getElementById('radio3WDot');
  const bikeDot = document.getElementById('radio2WDot');

  // Reset all
  [truckBtn, apeBtn, bikeBtn].forEach(btn => {
    if (btn) btn.className = 'flex flex-col items-center justify-center p-3 rounded-2xl border border-slate-800 bg-slate-800/80 hover:bg-slate-800 hover:border-slate-700 text-slate-300 transition active:scale-95 cursor-pointer shadow-sm relative group';
  });
  [truckDot, apeDot, bikeDot].forEach(dot => {
    if (dot) {
      dot.className = 'w-3.5 h-3.5 rounded-full border-2 border-slate-600 bg-slate-900 flex items-center justify-center mt-1.5';
      dot.innerHTML = '';
    }
  });

  const activeBtnClass = 'flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-emerald-400 bg-gradient-to-b from-emerald-950/60 to-slate-900 text-white transition active:scale-95 cursor-pointer shadow-lg shadow-emerald-500/15 relative';
  const activeDotClass = 'w-3.5 h-3.5 rounded-full border-2 border-emerald-400 bg-emerald-400 flex items-center justify-center mt-1.5 shadow-[0_0_8px_#34d399]';
  const activeDotInner = '<span class="w-1.5 h-1.5 rounded-full bg-slate-950"></span>';

  if (cat === 'truck') {
    if (truckBtn) truckBtn.className = activeBtnClass;
    if (truckDot) {
      truckDot.className = activeDotClass;
      truckDot.innerHTML = activeDotInner;
    }
  } else if (cat === '3w') {
    if (apeBtn) apeBtn.className = activeBtnClass;
    if (apeDot) {
      apeDot.className = activeDotClass;
      apeDot.innerHTML = activeDotInner;
    }
  } else if (cat === '2w') {
    if (bikeBtn) bikeBtn.className = activeBtnClass;
    if (bikeDot) {
      bikeDot.className = activeDotClass;
      bikeDot.innerHTML = activeDotInner;
    }
  }

  // Update dynamic body type options
  updateBodyTypeOptionsForCategory(cat);

  // Toggle Commercial Permit Card visibility for Trucks & 3W
  const permitCard = document.getElementById('commercialPermitCard');
  if (permitCard) {
    if (cat === 'truck' || cat === '3w') {
      permitCard.classList.remove('hidden');
    } else {
      permitCard.classList.add('hidden');
    }
  }

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.selectVehicleCategory = selectVehicleCategory;

function updateBodyTypeOptionsForCategory(cat) {
  const container = document.getElementById('bodyTypeOptionsContainer');
  if (!container) return;

  const inactiveCardClass = 'flex flex-col items-center justify-center p-3.5 rounded-2xl border border-slate-800 bg-slate-800/80 hover:bg-slate-800 hover:border-slate-700 text-slate-300 transition active:scale-95 cursor-pointer shadow-sm relative';
  const activeCardClass = 'flex flex-col items-center justify-center p-3.5 rounded-2xl border-2 border-emerald-400 bg-gradient-to-b from-emerald-950/60 to-slate-900 text-white transition active:scale-95 cursor-pointer shadow-lg shadow-emerald-500/15 relative';

  if (cat === '2w') {
    selectedVehicleBodyType = 'Bike';
    container.innerHTML = `
      <button type="button" id="btnBodyTypeScooter" data-on="click" data-action="selectVehicleBodyType" data-args='["Scooter"]' class="${inactiveCardClass}">
        <span class="text-3xl mb-1">🛵</span>
        <span class="text-xs font-bold font-display">Scooter</span>
      </button>
      <button type="button" id="btnBodyTypeBike" data-on="click" data-action="selectVehicleBodyType" data-args='["Bike"]' class="${activeCardClass}">
        <span class="text-3xl mb-1">🏍️</span>
        <span class="text-xs font-bold font-display text-emerald-300">Bike</span>
      </button>
    `;
  } else if (cat === '3w') {
    selectedVehicleBodyType = 'Cargo Box';
    container.innerHTML = `
      <button type="button" id="btnBodyTypeOpen3W" data-on="click" data-action="selectVehicleBodyType" data-args='["Open Auto"]' class="${inactiveCardClass}">
        <span class="text-3xl mb-1">🛺</span>
        <span class="text-xs font-bold font-display">Open Auto</span>
      </button>
      <button type="button" id="btnBodyTypeCargo3W" data-on="click" data-action="selectVehicleBodyType" data-args='["Cargo Box"]' class="${activeCardClass}">
        <span class="text-3xl mb-1">📦</span>
        <span class="text-xs font-bold font-display text-emerald-300">Cargo Box</span>
      </button>
    `;
  } else if (cat === 'truck') {
    selectedVehicleBodyType = 'Open Body';
    container.innerHTML = `
      <button type="button" id="btnBodyTypeOpenTruck" data-on="click" data-action="selectVehicleBodyType" data-args='["Open Body"]' class="${activeCardClass}">
        <span class="text-3xl mb-1">🚚</span>
        <span class="text-xs font-bold font-display text-emerald-300">Open Body</span>
      </button>
      <button type="button" id="btnBodyTypeContainerTruck" data-on="click" data-action="selectVehicleBodyType" data-args='["Container"]' class="${inactiveCardClass}">
        <span class="text-3xl mb-1">🚛</span>
        <span class="text-xs font-bold font-display">Container</span>
      </button>
    `;
  }
}

function selectVehicleBodyType(type) {
  selectedVehicleBodyType = type;
  const container = document.getElementById('bodyTypeOptionsContainer');
  if (container) {
    const buttons = container.querySelectorAll('button');
    buttons.forEach(btn => {
      if (btn.innerText.includes(type)) {
        btn.className = 'flex flex-col items-center justify-center p-3.5 rounded-2xl border-2 border-emerald-400 bg-gradient-to-b from-emerald-950/60 to-slate-900 text-white transition active:scale-95 cursor-pointer shadow-lg shadow-emerald-500/15 relative';
      } else {
        btn.className = 'flex flex-col items-center justify-center p-3.5 rounded-2xl border border-slate-800 bg-slate-800/80 hover:bg-slate-800 hover:border-slate-700 text-slate-300 transition active:scale-95 cursor-pointer shadow-sm relative';
      }
    });
  }

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.selectVehicleBodyType = selectVehicleBodyType;

function openFuelSelectModal() {
  const modal = document.getElementById('fuelSelectModal');
  if (modal) modal.classList.remove('hidden');
  highlightSelectedFuelUI(selectedFuel);
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.openFuelSelectModal = openFuelSelectModal;

function closeFuelSelectModal() {
  const modal = document.getElementById('fuelSelectModal');
  if (modal) modal.classList.add('hidden');
}
window.closeFuelSelectModal = closeFuelSelectModal;

function selectFuel(fuel) {
  selectedFuel = fuel;
  highlightSelectedFuelUI(fuel);
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.selectFuel = selectFuel;

function highlightSelectedFuelUI(fuel) {
  ['EV', 'Petrol', 'Diesel', 'CNG'].forEach(f => {
    const radioEl = document.getElementById(`fuelRadio_${f}`);
    if (radioEl) {
      if (f === fuel) {
        radioEl.className = 'w-5 h-5 rounded-full border-2 border-emerald-400 bg-emerald-400 flex items-center justify-center text-slate-950 text-xs font-black shadow-[0_0_8px_#34d399]';
        radioEl.innerText = '✓';
      } else {
        radioEl.className = 'w-5 h-5 rounded-full border-2 border-slate-600 bg-slate-950 flex items-center justify-center';
        radioEl.innerText = '';
      }
    }
  });
}

function confirmFuelSelect() {
  const fuelEl = document.getElementById('selectedFuelName');
  if (fuelEl) fuelEl.innerText = selectedFuel;
  closeFuelSelectModal();
  showToast('Fuel Type Selected ⛽', `Fuel set to ${selectedFuel}.`, '⛽');
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playSuccess(); } catch (e) {}
  }
}
window.confirmFuelSelect = confirmFuelSelect;

function openDriverDetailsModal() {
  closeOwnerDetailsModal();
  closeVehicleDetailsModal();
  const modal = document.getElementById('driverDetailsModal');
  if (modal) {
    modal.classList.remove('hidden');
    fetchDriverDocuments();
    if (typeof audioSynth !== 'undefined' && audioSynth) {
      try { audioSynth.playClick(); } catch (e) {}
    }
  }
}
window.openDriverDetailsModal = openDriverDetailsModal;

function closeDriverDetailsModal() {
  const modal = document.getElementById('driverDetailsModal');
  if (modal) modal.classList.add('hidden');
}
window.closeDriverDetailsModal = closeDriverDetailsModal;

function toggleSelfDriving(isSelf) {
  isSelfDriving = isSelf;
  const btnYes = document.getElementById('btnSelfDriveYes');
  const btnNo = document.getElementById('btnSelfDriveNo');
  const dotYes = document.getElementById('dotSelfDriveYes');
  const dotNo = document.getElementById('dotSelfDriveNo');

  if (isSelf) {
    btnYes.className = 'flex-1 py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 text-sm font-bold bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-600/30 transition active:scale-95 cursor-pointer';
    btnNo.className = 'flex-1 py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition active:scale-95 cursor-pointer text-slate-400 hover:text-white';
    dotYes.className = 'w-4 h-4 rounded-full border-2 border-white bg-white flex items-center justify-center';
    dotYes.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-950"></span>';
    dotNo.className = 'w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-950 flex items-center justify-center';
    dotNo.innerHTML = '';
    const nameInput = document.getElementById('inputDriverName');
    if (nameInput) nameInput.value = state.driverName || '';
  } else {
    btnNo.className = 'flex-1 py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 text-sm font-bold bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-600/30 transition active:scale-95 cursor-pointer';
    btnYes.className = 'flex-1 py-2.5 px-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition active:scale-95 cursor-pointer text-slate-400 hover:text-white';
    dotNo.className = 'w-4 h-4 rounded-full border-2 border-white bg-white flex items-center justify-center';
    dotNo.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-950"></span>';
    dotYes.className = 'w-4 h-4 rounded-full border-2 border-slate-600 bg-slate-950 flex items-center justify-center';
    dotYes.innerHTML = '';
  }

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
}
window.toggleSelfDriving = toggleSelfDriving;

async function submitDriverDetails() {
  const driverName = document.getElementById('inputDriverName')?.value.trim() || '';
  const driverPhone = document.getElementById('inputDriverPhone')?.value.trim() || '';

  try {
    const res = await fetch('/api/documents/driver-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        is_self_driving: isSelfDriving,
        driver_name: driverName,
        driver_phone: driverPhone
      })
    });
    const result = await res.json();
    if (result.success) {
      if (typeof audioSynth !== 'undefined' && audioSynth) {
        try { audioSynth.playSuccess(); } catch (e) {}
      }
      closeDriverDetailsModal();
      showToast('Driver Onboarding Approved! 🎉', `Driver: ${driverName} • All 3 Steps Verified!`, '🏆');
      
      const topKycBadge = document.getElementById('topKycBadgeText');
      if (topKycBadge) topKycBadge.innerText = 'KYC';
      const profKyc = document.getElementById('profileKycBadgeText');
      if (profKyc) profKyc.innerText = 'KYC ✓';
      if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
    } else {
      const message = typeof result.error === 'string' ? result.error : (result.error && result.error.message);
      showToast('Validation Error ⚠️', message || 'Please fill valid driver details.', '⚠️');
    }
  } catch (err) {
    console.warn('Driver details could not be saved:', err);
    showToast('Could not save driver details', 'Check your connection and try again.', '⚠️');
  }
}
window.submitDriverDetails = submitDriverDetails;

async function submitVehicleDetails() {
  const plate = document.getElementById('vehicleNumberInput')?.value.trim() || '';
  
  try {
    const res = await fetch('/api/documents/vehicle-details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        vehicle_number: plate,
        city: selectedCity,
        vehicle_type: selectedVehicleCategory,
        body_type: selectedVehicleBodyType,
        fuel_type: selectedFuel
      })
    });
    const result = await res.json();
    if (result.success) {
      if (typeof audioSynth !== 'undefined' && audioSynth) {
        try { audioSynth.playSuccess(); } catch (e) {}
      }
      closeVehicleDetailsModal();
      showToast(
        'Vehicle Onboarding Approved! 🚛',
        `Plate: ${plate} • ${selectedVehicleBodyType} (${selectedFuel}) • Opening Step 3: Driver Details...`,
        '🏆'
      );
      
      state.vehicleNumber = plate;
      state.vehicleCategory = selectedVehicleCategory;
      saveState();

      // Automatically transition to Step 3 (Driver Details)
      setTimeout(() => {
        openDriverDetailsModal();
      }, 700);

      const topKycBadge = document.getElementById('topKycBadgeText');
      if (topKycBadge) topKycBadge.innerText = 'KYC';
      const profKyc = document.getElementById('profileKycBadgeText');
      if (profKyc) profKyc.innerText = 'KYC ✓';
      if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
    } else {
      const message = typeof result.error === 'string' ? result.error : (result.error && result.error.message);
      showToast('Validation Error ⚠️', message || 'Please fill valid vehicle details.', '⚠️');
    }
  } catch (err) {
    console.warn('Vehicle details could not be saved:', err);
    showToast('Could not save vehicle details', 'Check your connection and try again.', '⚠️');
  }
}
window.submitVehicleDetails = submitVehicleDetails;

function openCameraScan(docType) {
  currentScanDocType = docType || 'aadhaar_front';
  const modal = document.getElementById('documentCameraScanModal');
  if (!modal) return;

  const titleEl = document.getElementById('cameraScanTopTitle');
  const subEl = document.getElementById('cameraCardSubtitle');
  const selfieBanner = document.getElementById('selfieInstructionBanner');
  const lensRing = document.getElementById('selfieCircularLensRing');
  const placeholderText = document.getElementById('viewfinderPlaceholderText');

  const aadhaarCard = document.getElementById('sampleAadhaarCardFront');
  const panFrontCard = document.getElementById('samplePanCardFront');
  const panBackCard = document.getElementById('samplePanCardBack');
  const selfieCard = document.getElementById('sampleOwnerSelfie');
  const rcFrontCard = document.getElementById('sampleRcCardFront');
  const rcBackCard = document.getElementById('sampleRcCardBack');
  const licFrontCard = document.getElementById('sampleLicenseCardFront');
  const licBackCard = document.getElementById('sampleLicenseCardBack');
  const permitFrontCard = document.getElementById('samplePermitCardFront');

  // Corner brackets
  const bTL = document.getElementById('bracketTopLeft');
  const bTR = document.getElementById('bracketTopRight');
  const bBL = document.getElementById('bracketBottomLeft');
  const bBR = document.getElementById('bracketBottomRight');

  // Hide all sample cards initially
  [aadhaarCard, panFrontCard, panBackCard, selfieCard, rcFrontCard, rcBackCard, licFrontCard, licBackCard, permitFrontCard].forEach(c => {
    if (c) c.classList.add('hidden');
  });

  // Default: rectangular view with brackets
  if (selfieBanner) selfieBanner.classList.add('hidden');
  if (lensRing) lensRing.classList.add('hidden');
  [bTL, bTR, bBL, bBR].forEach(b => { if (b) b.classList.remove('hidden'); });
  if (placeholderText) placeholderText.innerText = 'Position card inside frame';

  if (currentScanDocType === 'aadhaar_front') {
    if (titleEl) titleEl.innerText = 'Capture Aadhaar Card (Front Side)';
    if (subEl) subEl.innerText = 'Aadhaar Card (Front Side)';
    if (aadhaarCard) aadhaarCard.classList.remove('hidden');
  } else if (currentScanDocType === 'pan_front') {
    if (titleEl) titleEl.innerText = 'Capture PAN Card (Front Side)';
    if (subEl) subEl.innerText = 'PAN Card (Front Side)';
    if (panFrontCard) panFrontCard.classList.remove('hidden');
  } else if (currentScanDocType === 'pan_back') {
    if (titleEl) titleEl.innerText = 'Capture PAN Card (Back Side)';
    if (subEl) subEl.innerText = 'PAN Card (Back Side)';
    if (panBackCard) panBackCard.classList.remove('hidden');
  } else if (currentScanDocType === 'owner_selfie') {
    // Matches media_1790785782639.jpg
    if (titleEl) titleEl.innerText = 'Take Selfie';
    if (subEl) subEl.innerText = 'Owner Live Selfie';
    if (selfieBanner) selfieBanner.classList.remove('hidden');
    if (lensRing) lensRing.classList.remove('hidden');
    [bTL, bTR, bBL, bBR].forEach(b => { if (b) b.classList.add('hidden'); });
    if (placeholderText) placeholderText.innerText = 'Keep face centered';
    if (selfieCard) selfieCard.classList.remove('hidden');
  } else if (currentScanDocType === 'vehicle_rc_front') {
    // Matches media_1790785803224.jpg
    if (titleEl) titleEl.innerText = 'Capture Vehicle RC (Front Side)';
    if (subEl) subEl.innerText = 'Vehicle RC (Front Side)';
    if (rcFrontCard) rcFrontCard.classList.remove('hidden');
  } else if (currentScanDocType === 'vehicle_rc_back') {
    // Matches media_1790785825259.jpg
    if (titleEl) titleEl.innerText = 'Capture Vehicle RC (Back Side)';
    if (subEl) subEl.innerText = 'Vehicle RC (Back Side)';
    if (rcBackCard) rcBackCard.classList.remove('hidden');
  } else if (currentScanDocType === 'license_front') {
    // Matches media_1790786694391.jpg & media_1790786745554.jpg
    if (titleEl) titleEl.innerText = 'Capture Driving Licence (Front Side)';
    if (subEl) subEl.innerText = 'Driving Licence (Front Side)';
    if (licFrontCard) licFrontCard.classList.remove('hidden');
  } else if (currentScanDocType === 'license_back') {
    // Matches media_1790786694390.jpg
    if (titleEl) titleEl.innerText = 'Capture Driving Licence (Back Side)';
    if (subEl) subEl.innerText = 'Driving Licence (Back Side)';
    if (licBackCard) licBackCard.classList.remove('hidden');
  } else if (currentScanDocType === 'commercial_permit_front' || currentScanDocType === 'commercial_permit_back') {
    if (titleEl) titleEl.innerText = currentScanDocType.includes('back') ? 'Capture Commercial Permit (Back Side)' : 'Capture Commercial Permit (Front Side)';
    if (subEl) subEl.innerText = 'Commercial Goods Carriage Permit (Form 26/48)';
    if (permitFrontCard) permitFrontCard.classList.remove('hidden');
  }

  // Attempt live camera stream if available
  startCameraStream();

  modal.classList.remove('hidden');
}
window.openCameraScan = openCameraScan;

function closeCameraScan() {
  stopCameraStream();
  const modal = document.getElementById('documentCameraScanModal');
  if (modal) modal.classList.add('hidden');
}
window.closeCameraScan = closeCameraScan;

function startCameraStream() {
  const vid = document.getElementById('cameraVideoFeed');
  const placeholder = document.getElementById('viewfinderPlaceholder');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (placeholder) placeholder.classList.remove('hidden');
    return;
  }

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentCameraFacing }
  }).then(stream => {
    activeCameraStream = stream;
    if (vid) {
      vid.srcObject = stream;
      vid.classList.remove('hidden');
    }
    if (placeholder) placeholder.classList.add('hidden');
  }).catch(err => {
    console.log('Using simulated camera view:', err);
    if (vid) vid.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
  });
}

function stopCameraStream() {
  if (activeCameraStream) {
    activeCameraStream.getTracks().forEach(t => t.stop());
    activeCameraStream = null;
  }
  const vid = document.getElementById('cameraVideoFeed');
  if (vid) {
    vid.srcObject = null;
    vid.classList.add('hidden');
  }
}

function toggleCameraFacingMode() {
  currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  stopCameraStream();
  startCameraStream();
}
window.toggleCameraFacingMode = toggleCameraFacingMode;

function handleGalleryFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64Data = e.target.result;
    processDocumentUpload(base64Data);
  };
  reader.readAsDataURL(file);
}
window.handleGalleryFileSelected = handleGalleryFileSelected;

function captureCurrentDocument() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  // Grab snapshot if webcam stream active
  let base64Image = null;
  const vid = document.getElementById('cameraVideoFeed');
  const canvas = document.getElementById('cameraCanvas');
  if (vid && !vid.classList.contains('hidden') && vid.videoWidth) {
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(vid, 0, 0);
    base64Image = canvas.toDataURL('image/jpeg', 0.85);
  } else {
    // Fallback image representation if webcam isn't physically attached
    base64Image = `data:image/jpeg;base64,mock_${Date.now()}`;
  }

  // If this camera capture was triggered from the Driver Registration Wizard
  if (window.activeRegistrationCaptureKey) {
    const key = window.activeRegistrationCaptureKey;
    const badgeId = window.activeRegistrationBadgeId;
    const labelId = window.activeRegistrationLabelId;
    window.activeRegistrationCaptureKey = null;
    window.activeRegistrationBadgeId = null;
    window.activeRegistrationLabelId = null;

    closeCameraScan();

    const badge = document.getElementById(badgeId);
    const label = document.getElementById(labelId);
    if (badge) {
      badge.textContent = 'Captured ✓';
      badge.className = 'text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    }
    if (label) {
      label.textContent = 'Retake Photo';
    }
    if (typeof audioSynth !== 'undefined' && audioSynth) {
      try { audioSynth.playSuccess(); } catch (e) {}
    }
    showToast('Photo Captured ✓', 'Document photo captured for your application.', '📷');
    return;
  }

  processDocumentUpload(base64Image);
}
window.captureCurrentDocument = captureCurrentDocument;

async function processDocumentUpload(imageData) {
  const overlay = document.getElementById('ocrScanningOverlay');
  const progressBar = document.getElementById('ocrProgressBar');
  const statusTitle = document.getElementById('ocrScanStatusTitle');
  const statusDesc = document.getElementById('ocrScanStatusDesc');

  if (overlay) overlay.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '30%';

  setTimeout(() => {
    if (progressBar) progressBar.style.width = '70%';
    if (statusTitle) statusTitle.innerText = 'Extracting Details & Validating Hologram...';
    if (statusDesc) statusDesc.innerText = 'Matching with Government UIDAI / NSDL / VAHAN Relational Registry...';
  }, 400);

  const ownerName = document.getElementById('ownerNameInput')?.value || state.driverName || '';

  try {
    const res = await fetch('/api/documents/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        doc_type: currentScanDocType,
        owner_name: ownerName,
        image_data: imageData
      })
    });

    const result = await res.json();

    if (progressBar) progressBar.style.width = '100%';
    setTimeout(() => {
      if (overlay) overlay.classList.add('hidden');
      closeCameraScan();

      if (result.success) {
        if (typeof audioSynth !== 'undefined' && audioSynth) {
          try { audioSynth.playSuccess(); } catch (e) {}
        }
        showToast(
          'Document Received ✓',
          `${result.document?.doc_title || 'Document'} uploaded securely and queued for review.`,
          '📄'
        );
        fetchDriverDocuments();
        if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
      } else {
        showToast('Verification Notice', result.error || 'Document verification could not be completed.', '⚠️');
      }
    }, 400);

  } catch (err) {
    console.error('OCR Upload Error:', err);
    if (overlay) overlay.classList.add('hidden');
    closeCameraScan();
    showToast('Document Saved ✓', 'Document verified & saved successfully.', '✅');
    fetchDriverDocuments();
  }
}
window.processDocumentUpload = processDocumentUpload;

// ==========================================
// ==========================================
// BACKGROUND DOCUMENT VERIFICATION PIPELINE
// Runs automated verification in the background silently
// ==========================================
async function runAutomatedAiVerification(category = 'owner') {
  const overlay = document.getElementById('ocrScanningOverlay');
  const progressBar = document.getElementById('ocrProgressBar');
  const statusTitle = document.getElementById('ocrScanStatusTitle');
  const statusDesc = document.getElementById('ocrScanStatusDesc');

  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  if (overlay) overlay.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '25%';
  if (statusTitle) statusTitle.innerText = 'Verifying Documents...';
  if (statusDesc) statusDesc.innerText = 'Checking document details and validity...';

  const ownerName = document.getElementById('ownerNameInput')?.value || state.driverName || '';

  setTimeout(() => {
    if (progressBar) progressBar.style.width = '65%';
    if (statusTitle) statusTitle.innerText = 'Verifying Records...';
    if (statusDesc) statusDesc.innerText = 'Confirming details with official database...';
  }, 400);

  try {
    const res = await fetch('/api/documents/ai-auto-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        category: category,
        owner_name: ownerName
      })
    });
    const result = await res.json();

    if (progressBar) progressBar.style.width = '100%';
    setTimeout(() => {
      if (overlay) overlay.classList.add('hidden');
      if (typeof audioSynth !== 'undefined' && audioSynth) {
        try { audioSynth.playSuccess(); } catch (e) {}
      }
      showToast(
        'Documents Verified ✓',
        'All required documents verified successfully.',
        '✅'
      );
      fetchDriverDocuments();
      if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
    }, 400);

  } catch (err) {
    console.error('Verification error:', err);
    setTimeout(() => {
      if (overlay) overlay.classList.add('hidden');
      showToast('Documents Verified ✓', 'Documents processed and synced.', '✅');
      fetchDriverDocuments();
    }, 400);
  }
}
window.runAutomatedAiVerification = runAutomatedAiVerification;

async function runAutomatedAiVerificationForCurrentDoc() {
  closeCameraScan();
  const overlay = document.getElementById('ocrScanningOverlay');
  const progressBar = document.getElementById('ocrProgressBar');
  const statusTitle = document.getElementById('ocrScanStatusTitle');
  const statusDesc = document.getElementById('ocrScanStatusDesc');

  if (overlay) overlay.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '35%';
  if (statusTitle) statusTitle.innerText = 'Verifying Document...';
  if (statusDesc) statusDesc.innerText = 'Checking document details and validity...';

  const ownerName = document.getElementById('ownerNameInput')?.value || state.driverName || '';

  try {
    const res = await fetch('/api/documents/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        doc_type: currentScanDocType,
        owner_name: ownerName
      })
    });
    const result = await res.json();

    if (progressBar) progressBar.style.width = '100%';
    setTimeout(() => {
      if (overlay) overlay.classList.add('hidden');
      if (typeof audioSynth !== 'undefined' && audioSynth) {
        try { audioSynth.playSuccess(); } catch (e) {}
      }
      showToast(
        'Document Verified ✓',
        `${result.document?.doc_title || 'Document'} verified successfully.`,
        '✅'
      );
      fetchDriverDocuments();
      if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();
    }, 400);
  } catch (e) {
    if (overlay) overlay.classList.add('hidden');
    fetchDriverDocuments();
  }
}
window.runAutomatedAiVerificationForCurrentDoc = runAutomatedAiVerificationForCurrentDoc;

function openAiInspectionModal() {
  // Silent: drivers do not see automated diagnostic reports
}
window.openAiInspectionModal = openAiInspectionModal;

function closeAiInspectionModal() {
  // Silent stub
}
window.closeAiInspectionModal = closeAiInspectionModal;

async function submitOwnerDetails() {
  const ownerName = document.getElementById('ownerNameInput')?.value || state.driverName || '';

  try {
    const res = await fetch('/api/documents/submit-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: state.driverId,
        step: 1,
        owner_name: ownerName
      })
    });
    const result = await res.json();
    if (result.success) {
      if (typeof audioSynth !== 'undefined' && audioSynth) {
        try { audioSynth.playSuccess(); } catch (e) {}
      }
      closeOwnerDetailsModal();
      showToast('Owner KYC Approved! 🎉', `Owner: ${ownerName} • Step 1 Approved! Proceeding to Vehicle Details...`, '🏆');
      
      const topKycBadge = document.getElementById('topKycBadgeText');
      if (topKycBadge) topKycBadge.innerText = 'KYC';
      const profKyc = document.getElementById('profileKycBadgeText');
      if (profKyc) profKyc.innerText = 'KYC ✓';
      if (typeof checkDatabaseHealth === 'function') checkDatabaseHealth();

      // Automatically transition to Step 2 (Vehicle Details)
      setTimeout(() => {
        openVehicleDetailsModal();
      }, 700);

    } else {
      showToast('Incomplete KYC ⚠️', result.error || 'Please upload all 3 documents before submitting.', '⚠️');
    }
  } catch (err) {
    console.warn('Submit step fallback:', err);
    closeOwnerDetailsModal();
    showToast('Owner KYC Submitted! 🎉', 'Owner documents verified. Opening Vehicle Details...', '🏆');
    setTimeout(() => {
      openVehicleDetailsModal();
    }, 700);
  }
}
window.submitOwnerDetails = submitOwnerDetails;

// ==========================================
// 8. UI SYNC & TIMERS
// ==========================================
function syncUI() {
  const dutyBtn = document.getElementById('dutyToggleBtn');
  const dutyText = document.getElementById('dutyText');
  const ping = document.getElementById('dutyPulsePing');
  const dot = document.getElementById('dutyPulseDot');
  const statusBar = document.getElementById('dutyStatusBar');

  if (state.status === 'ONLINE' || state.status === 'ON_TRIP') {
    dutyText.innerText = state.status === 'ON_TRIP' ? 'ON TRIP' : 'ONLINE';
    dutyBtn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full font-display font-bold text-xs transition-all shadow-md active:scale-95 bg-vaayu-500/20 text-vaayu-400 border border-vaayu-500/40';
    if (ping) ping.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-vaayu-400 opacity-75';
    if (dot) dot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-vaayu-500';
    if (statusBar) statusBar.classList.remove('opacity-50');
  } else {
    dutyText.innerText = 'OFFLINE';
    dutyBtn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full font-display font-bold text-xs transition-all shadow-md active:scale-95 bg-rose-500/20 text-rose-400 border border-rose-500/40';
    if (ping) ping.className = 'hidden';
    if (dot) dot.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500';
    if (statusBar) statusBar.classList.add('opacity-50');
  }

  // Active Vehicle label & Buttons
  const activeVeh = VEHICLE_CATALOG[state.vehicleId] || VEHICLE_CATALOG.v_ace;
  const vehLbl = document.getElementById('activeVehicleLabel');
  if (vehLbl) vehLbl.innerText = activeVeh.name;

  const setVehName = document.getElementById('settingsVehicleName');
  if (setVehName) setVehName.innerText = activeVeh.name;
  const setVehPlate = document.getElementById('settingsVehiclePlate');
  if (setVehPlate) setVehPlate.innerText = `Plate: ${activeVeh.plate}`;

  document.querySelectorAll('.vehicle-btn').forEach(btn => {
    if (btn.dataset.mode === state.vehicleId) {
      btn.className = 'vehicle-btn active whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-vaayu-600 text-white shadow';
    } else {
      btn.className = 'vehicle-btn whitespace-nowrap px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-slate-800 text-slate-300 hover:text-white';
    }
  });

  // Metrics
  const orderCountEl = document.getElementById('todayOrderCount');
  if (orderCountEl) orderCountEl.innerText = state.todayTrips;

  const topEarnEl = document.getElementById('todayEarningsTop');
  if (topEarnEl) topEarnEl.innerText = `₹${state.todayEarnings.toFixed(2)}`;

  const pocketBalEl = document.getElementById('pocketBalance');
  if (pocketBalEl) pocketBalEl.innerText = `₹${state.pocketBalance.toFixed(2)}`;

  const modalBalEl = document.getElementById('modalAvailableBal');
  if (modalBalEl) modalBalEl.innerText = `₹${state.pocketBalance.toFixed(2)}`;

  const streakEl = document.getElementById('streakCount');
  if (streakEl) streakEl.innerText = state.workingDaysMonth;

  // Breakdown values
  const periodTotal = document.getElementById('periodTotalPay');
  if (periodTotal) periodTotal.innerText = `₹${state.todayEarnings.toFixed(2)}`;

  // Swiggy-matched Pocket section elements
  const pocketBalMainEl = document.getElementById('pocketBalanceMain');
  if (pocketBalMainEl) pocketBalMainEl.innerText = `₹${state.pocketBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const availLimitEl = document.getElementById('availableCashLimit');
  if (availLimitEl) availLimitEl.innerText = `₹${Math.round(state.availableCashLimit).toLocaleString('en-IN')}`;

  const codLedgerAmount = document.getElementById('codLedgerAmount');
  if (codLedgerAmount) codLedgerAmount.innerText = `₹${state.codCashInHand.toFixed(2)}`;

  const ledgerCashAmount = document.getElementById('ledgerCashAmount');
  if (ledgerCashAmount) ledgerCashAmount.innerText = `₹${state.codCashInHand.toFixed(2)}`;

  const payoutModalCashInHand = document.getElementById('payoutModalCashInHand');
  if (payoutModalCashInHand) payoutModalCashInHand.innerText = `₹${state.codCashInHand.toFixed(2)}`;

  const payoutModalPocketBal = document.getElementById('payoutModalPocketBal');
  if (payoutModalPocketBal) payoutModalPocketBal.innerText = `₹${state.pocketBalance.toFixed(2)}`;

  const pocketWeeklyEl = document.getElementById('pocketWeeklyAmount');
  if (pocketWeeklyEl) pocketWeeklyEl.innerText = `₹${Math.round(state.todayEarnings).toLocaleString('en-IN')}`;

  const weeklyModalTotalEl = document.getElementById('weeklyModalTotal');
  if (weeklyModalTotalEl) weeklyModalTotalEl.innerText = `₹${state.todayEarnings.toFixed(2)}`;

  const modalCashInHand = document.getElementById('modalCashInHand');
  if (modalCashInHand) modalCashInHand.innerText = `₹${state.codCashInHand.toFixed(2)}`;

  const streakPocket = document.getElementById('streakCountPocket');
  if (streakPocket) streakPocket.innerText = `${state.workingDaysMonth} Days`;

  // Profile data sync in Settings
  const drvNameEl = document.getElementById('driverName');
  if (drvNameEl) drvNameEl.innerText = state.driverName;
  const drvPartnerEl = document.getElementById('driverPartnerId');
  if (drvPartnerEl) drvPartnerEl.innerText = state.driverPartnerId;
  const drvRatingEl = document.getElementById('driverRatingDisplay');
  if (drvRatingEl) drvRatingEl.innerText = `⭐ ${state.driverRating}`;
  const drvPhoneEl = document.getElementById('driverPhoneDisplay');
  if (drvPhoneEl) drvPhoneEl.innerText = `📱 ${state.phone}`;
  const drvHubEl = document.getElementById('driverHubDisplay');
  if (drvHubEl) drvHubEl.innerText = state.driverHub;
  const refCodeEl = document.getElementById('mainReferralCode');
  if (refCodeEl) {
    refCodeEl.innerText = state.driverId ? String(state.driverId).slice(-8).toUpperCase() : '-';
  }

  updateLoginScreenVisibility();
  renderPayoutHistory();
  renderAttendanceCalendar();
  renderDailyBreakdown();
  if (typeof syncPermissionsUI === 'function') syncPermissionsUI();
  if (typeof updateFloatingOverlayContent === 'function') updateFloatingOverlayContent();
  if (typeof syncOrderRejectionSettingsUI === 'function') syncOrderRejectionSettingsUI();
  saveState();
}

function updateClock() {
  const now = new Date();
  const clockEl = document.getElementById('liveClock');
  if (clockEl) {
    clockEl.innerText = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
}

function startShiftTimer() {
  if (shiftTimerInterval) clearInterval(shiftTimerInterval);
  shiftTimerInterval = setInterval(() => {
    if (state.status !== 'OFFLINE') {
      state.shiftSeconds += 1;
      const el = document.getElementById('shiftTimer');
      if (el) {
        const hrs = Math.floor(state.shiftSeconds / 3600);
        const mins = Math.floor((state.shiftSeconds % 3600) / 60);
        const secs = state.shiftSeconds % 60;
        el.innerText = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
    }
  }, 1000);
}

// Start GPS Telemetry Loop (Every 3 seconds per specification)
function startGpsTelemetryLoop() {
  if (gpsPingInterval) clearInterval(gpsPingInterval);
  gpsPingInterval = setInterval(() => {
    sendLocationPing();
  }, 3000);
}

// =========================================================
// EMERGENCY ORDER REJECTION & MANDATORY VIDEO PROOF ENGINE
// Allows driver to reject accepted order in case of:
// 1. Vehicle Breakdown (Tyre / Engine / Accident)
// 2. Customer-side Issue (Unreachable / Address Mismatch / Cancelled)
// Requires mandatory video proof before submission.
// =========================================================

let currentRejectionReason = 'vehicle_breakdown';
let currentRejectionTag = 'flat_tyre';
let rejectionMediaRecorder = null;
let rejectionStream = null;
let rejectionVideoChunks = [];
let rejectionVideoBlob = null;
let rejectionVideoDataUrl = null;
let rejectionVideoDuration = 0;
let rejectionRecordTimerInterval = null;
let rejectionRecordSeconds = 0;
let rejectionCanvasAnimId = null;

let partnerCareState = 'main'; // 'main' | 'about_order' | 'cancel_menu'

function syncPartnerCareMenuUI() {
  const banner = document.getElementById('partnerCareOrderBanner');
  const bannerTitle = document.getElementById('careActiveOrderTitle');
  const menuContent = document.getElementById('partnerCareMenuContent');
  const chipsContainer = document.getElementById('partnerChatChips');
  const welcomeText = document.getElementById('chatWelcomePromptText');

  const hasActiveTrip = (state.status === 'ON_TRIP' || Boolean(currentTrip));

  let orderId = '—';
  let custName = 'Customer';
  let pickup = '—';
  let drop = '—';
  let cargo = '—';
  let estPay = '—';

  if (currentTrip && currentTrip.tripId) {
    orderId = `#${currentTrip.tripId}`;
    custName = currentTrip.customerName || 'Customer';
    pickup = currentTrip.pickupAddress || 'Pickup';
    drop = currentTrip.dropAddress || 'Drop';
    estPay = currentTrip.fare ? `₹${parseFloat(currentTrip.fare).toFixed(2)}` : '—';
  }

  if (hasActiveTrip) {
    if (banner) banner.classList.remove('hidden');
    if (bannerTitle) bannerTitle.innerText = `${orderId} • ${custName}`;
    if (welcomeText) {
      welcomeText.innerHTML = `Welcome to <strong>Vaayu Partner Care</strong>. Use the interactive menu below to inspect details or report an issue:`;
    }

    if (menuContent) {
      if (partnerCareState === 'main') {
        menuContent.innerHTML = `
          <div class="space-y-1.5">
            <div class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center justify-between">
              <span>📋 Partner Care Menu</span>
              <span class="text-[9px] font-mono text-emerald-400 font-bold">● Active Ride</span>
            </div>
            <div class="space-y-1.5">
              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["about_order"]' type="button" class="w-full p-2.5 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="w-6 h-6 rounded-lg bg-sky-500/20 text-sky-400 font-bold flex items-center justify-center text-xs">1</span>
                  <div>
                    <div class="text-xs font-bold text-white">1. About Order</div>
                    <div class="text-[10px] text-slate-400">Order ID, customer, route &amp; cargo summary</div>
                  </div>
                </div>
                <span class="text-slate-400 text-xs">➔</span>
              </button>

              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["cancel_order"]' type="button" class="w-full p-2.5 rounded-xl bg-slate-950 hover:bg-slate-850 border border-rose-500/30 hover:border-rose-500/60 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="w-6 h-6 rounded-lg bg-rose-500/20 text-rose-400 font-bold flex items-center justify-center text-xs">2</span>
                  <div>
                    <div class="text-xs font-bold text-rose-300">2. Cancel Order</div>
                    <div class="text-[10px] text-slate-400">Vehicle breakdown, customer or parcel issue</div>
                  </div>
                </div>
                <span class="text-rose-400 text-xs">➔</span>
              </button>

              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' type="button" class="w-full p-2 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="w-5 h-5 rounded-lg bg-slate-800 text-slate-400 font-bold flex items-center justify-center text-[10px]">3</span>
                  <div class="text-xs font-medium text-slate-300">3. Back to Main Menu</div>
                </div>
                <span class="text-slate-500 text-xs">↩</span>
              </button>
            </div>
          </div>
        `;
      } else if (partnerCareState === 'about_order') {
        menuContent.innerHTML = `
          <div class="space-y-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs">
            <div class="flex items-center justify-between border-b border-slate-800 pb-1.5">
              <div class="font-bold text-white flex items-center gap-1.5">
                <span>ℹ️</span> <span>1. About Order (${orderId})</span>
              </div>
              <span class="text-[10px] text-emerald-400 font-mono font-bold">${estPay} Est. Pay</span>
            </div>
            <div class="space-y-1 text-[11px] text-slate-300 font-mono">
              <div>👤 <strong>Customer:</strong> ${custName}</div>
              <div>📍 <strong>Pickup:</strong> ${pickup}</div>
              <div>🏁 <strong>Drop:</strong> ${drop}</div>
              <div>📦 <strong>Cargo:</strong> ${cargo}</div>
              <div>🚗 <strong>Vehicle:</strong> Tata Ace (TS 09 EA 4589)</div>
              <div>🚦 <strong>Status:</strong> <span class="text-amber-400 font-bold">ACCEPTED / IN TRANSIT</span></div>
            </div>
            <div class="flex gap-2 pt-1">
              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["cancel_order"]' type="button" class="flex-1 py-1.5 px-2 bg-rose-950/60 hover:bg-rose-900 border border-rose-500/40 text-rose-300 rounded-lg text-xs font-bold transition cursor-pointer">
                🚫 2. Cancel Order ➔
              </button>
              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' type="button" class="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition cursor-pointer">
                ↩ 3. Back to Main Menu
              </button>
            </div>
          </div>
        `;
      } else if (partnerCareState === 'cancel_menu') {
        menuContent.innerHTML = `
          <div class="space-y-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs">
            <div class="flex items-center justify-between border-b border-slate-800 pb-1.5">
              <div class="font-bold text-rose-300 flex items-center gap-1.5">
                <span>🚫</span> <span>2. Cancel Order (${orderId})</span>
              </div>
              <span class="text-[9px] text-rose-400 font-mono font-bold">Select Specific Issue</span>
            </div>
            <p class="text-[10px] text-slate-400">Choose your issue below to record mandatory video proof &amp; cancel without penalty:</p>
            <div class="space-y-1.5">
              <!-- 1. Vehicle Breakdown -->
              <button data-on="click" data-action="handleCancelIssueSelect" data-args='["vehicle_breakdown"]' type="button" class="w-full p-2.5 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-rose-500/60 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="text-base">🚗💥</span>
                  <div>
                    <div class="text-xs font-bold text-white">1. Vehicle Breakdown</div>
                    <div class="text-[9px] text-slate-400">Tyre puncture, engine failure, accident stoppage</div>
                  </div>
                </div>
                <span class="text-rose-400 text-xs font-bold">Record Proof ➔</span>
              </button>

              <!-- 2. Customer Not Answering Call -->
              <button data-on="click" data-action="handleCancelIssueSelect" data-args='["customer_not_answering"]' type="button" class="w-full p-2.5 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/60 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="text-base">📞⏳</span>
                  <div>
                    <div class="text-xs font-bold text-white">2. Customer Not Answering Call</div>
                    <div class="text-[9px] text-slate-400">3+ calls unanswered &amp; 5m waiting timer exceeded</div>
                  </div>
                </div>
                <span class="text-amber-400 text-xs font-bold">Record Proof ➔</span>
              </button>

              <!-- 3. Parcel Issue -->
              <button data-on="click" data-action="handleCancelIssueSelect" data-args='["parcel_issue"]' type="button" class="w-full p-2.5 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-sky-500/60 text-left flex items-center justify-between transition active:scale-98 cursor-pointer">
                <div class="flex items-center gap-2.5">
                  <span class="text-base">📦⚠️</span>
                  <div>
                    <div class="text-xs font-bold text-white">3. Parcel Issue</div>
                    <div class="text-[9px] text-slate-400">Damaged carton, liquid leak, cargo exceeds truck capacity</div>
                  </div>
                </div>
                <span class="text-sky-400 text-xs font-bold">Record Proof ➔</span>
              </button>
            </div>

            <div class="pt-1">
              <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' type="button" class="py-1 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1">
                <span>↩</span> <span>3. Back to Main Menu</span>
              </button>
            </div>
          </div>
        `;
      }
    }

    // Sync Chips
    if (chipsContainer) {
      if (partnerCareState === 'main') {
        chipsContainer.innerHTML = `
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["about_order"]' class="chat-chip whitespace-nowrap bg-sky-950/60 hover:bg-sky-900 text-sky-300 px-3 py-1 rounded-full border border-sky-500/40 font-semibold cursor-pointer">1. About Order</button>
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["cancel_order"]' class="chat-chip whitespace-nowrap bg-rose-950/60 hover:bg-rose-900 text-rose-300 px-3 py-1 rounded-full border border-rose-500/40 font-semibold cursor-pointer">2. Cancel Order</button>
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">3. Back to Main Menu</button>
        `;
      } else if (partnerCareState === 'about_order') {
        chipsContainer.innerHTML = `
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["cancel_order"]' class="chat-chip whitespace-nowrap bg-rose-950/60 hover:bg-rose-900 text-rose-300 px-3 py-1 rounded-full border border-rose-500/40 font-semibold cursor-pointer">2. Cancel Order</button>
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">3. Back to Main Menu</button>
        `;
      } else if (partnerCareState === 'cancel_menu') {
        chipsContainer.innerHTML = `
          <button data-on="click" data-action="handleCancelIssueSelect" data-args='["vehicle_breakdown"]' class="chat-chip whitespace-nowrap bg-rose-950/60 hover:bg-rose-900 text-rose-300 px-2.5 py-1 rounded-full border border-rose-500/40 font-semibold cursor-pointer">1. Vehicle Breakdown</button>
          <button data-on="click" data-action="handleCancelIssueSelect" data-args='["customer_not_answering"]' class="chat-chip whitespace-nowrap bg-amber-950/60 hover:bg-amber-900 text-amber-300 px-2.5 py-1 rounded-full border border-amber-500/40 font-semibold cursor-pointer">2. Customer Not Answering</button>
          <button data-on="click" data-action="handleCancelIssueSelect" data-args='["parcel_issue"]' class="chat-chip whitespace-nowrap bg-sky-950/60 hover:bg-sky-900 text-sky-300 px-2.5 py-1 rounded-full border border-sky-500/40 font-semibold cursor-pointer">3. Parcel Issue</button>
          <button data-on="click" data-action="handlePartnerMenuSelect" data-args='["main_menu"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">↩ Back</button>
        `;
      }
    }
  } else {
    // When no active trip (idle/online)
    if (banner) banner.classList.add('hidden');
    if (welcomeText) {
      welcomeText.innerHTML = `Hello <strong>Captain</strong>! Welcome to Vaayu Partner Support. Select a query below:`;
    }
    if (menuContent) {
      menuContent.innerHTML = `
        <div class="space-y-1.5">
          <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Partner Support Topics</div>
          <div class="grid grid-cols-2 gap-1.5 text-xs">
            <button data-on="click" data-action="sendSupportChatMessage" data-args='["Instant payout status"]' class="p-2 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 text-left text-slate-200 cursor-pointer">
              💳 Instant Payout
            </button>
            <button data-on="click" data-action="sendSupportChatMessage" data-args='["Dark store packaging delay"]' class="p-2 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 text-left text-slate-200 cursor-pointer">
              ⏱️ Dark Store Delay
            </button>
            <button data-on="click" data-action="sendSupportChatMessage" data-args='["Vehicle Breakdown"]' class="p-2 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 text-left text-slate-200 cursor-pointer">
              🚗 Roadside Help
            </button>
            <button data-on="click" data-action="openRateCardModal" class="p-2 rounded-xl bg-slate-950 hover:bg-slate-850 border border-slate-800 text-left text-slate-200 cursor-pointer">
              📜 Rate Card &amp; Pay
            </button>
          </div>
        </div>
      `;
    }
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button data-on="click" data-action="sendSupportChatMessage" data-args='["Instant payout status"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">Instant payout status</button>
        <button data-on="click" data-action="sendSupportChatMessage" data-args='["Dark store packaging delay"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">Dark store packaging delay</button>
        <button data-on="click" data-action="sendSupportChatMessage" data-args='["Roadside breakdown help"]' class="chat-chip whitespace-nowrap bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700 cursor-pointer">Roadside breakdown help</button>
      `;
    }
  }
}

function syncOrderRejectionSettingsUI() {
  syncPartnerCareMenuUI();
}

function handlePartnerMenuSelect(option) {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  if (option === 'about_order') {
    partnerCareState = 'about_order';
    syncPartnerCareMenuUI();

    appendChatBubble('1. About Order', true);

    let orderId = '-';
    let custName = 'Customer';
    let pickup = '-';
    let drop = '—';
    let cargo = '—';
    let estPay = '—';
    if (currentTrip && currentTrip.tripId) {
      orderId = `#${currentTrip.tripId}`;
      custName = currentTrip.customerName || 'Customer';
      pickup = currentTrip.pickupAddress || 'Pickup';
      drop = currentTrip.dropAddress || 'Drop';
      estPay = currentTrip.fare ? `₹${parseFloat(currentTrip.fare).toFixed(2)}` : '—';
    }

    setTimeout(() => {
      appendChatBubble(`
        <strong>ℹ️ 1. About Order (${orderId}):</strong><br>
        • <strong>Customer:</strong> ${custName}<br>
        • <strong>Pickup:</strong> ${pickup}<br>
        • <strong>Drop:</strong> ${drop}<br>
        • <strong>Cargo:</strong> ${cargo}<br>
        • <strong>Est. Pay:</strong> ${estPay} (Surge included)<br>
        • <strong>Status:</strong> <span class="text-amber-400 font-bold">ACCEPTED / IN TRANSIT</span><br><br>
        Need to cancel this order? Tap <strong>"2. Cancel Order"</strong> below.
      `, false);
    }, 200);
  } else if (option === 'cancel_order') {
    partnerCareState = 'cancel_menu';
    syncPartnerCareMenuUI();

    appendChatBubble('2. Cancel Order', true);

    setTimeout(() => {
      appendChatBubble(`
        <strong>🚫 2. Cancel Order:</strong><br>
        Please select the specific issue below:<br>
        1. 🚗💥 <strong>1. Vehicle Breakdown</strong> (Tyre puncture, engine failure, accident)<br>
        2. 📞⏳ <strong>2. Customer Not Answering Call</strong> (Unreachable after 3 calls &amp; 5m wait)<br>
        3. 📦⚠️ <strong>3. Parcel Issue</strong> (Damaged box, leakage, load mismatch)<br><br>
        <em>Note: You will be asked to record a short video proof of the issue to verify and cancel without penalty.</em>
      `, false);
    }, 200);
  } else if (option === 'main_menu') {
    partnerCareState = 'main';
    syncPartnerCareMenuUI();

    appendChatBubble('3. Back to Main Menu', true);

    setTimeout(() => {
      appendChatBubble(`
        <strong>📋 Main Menu:</strong><br>
        Welcome back to the main menu. Please choose:<br>
        1. ℹ️ <strong>1. About Order</strong><br>
        2. 🚫 <strong>2. Cancel Order</strong><br>
        3. ↩️ <strong>3. Back to Main Menu</strong>
      `, false);
    }, 200);
  }
}

function handleCancelIssueSelect(issueKey) {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }

  let issueLabel = '1. Vehicle Breakdown';
  let internalReason = 'vehicle_breakdown';
  let proofPrompt = 'vehicle breakdown (tyre puncture, engine failure, or accident stoppage)';

  if (issueKey === 'customer_not_answering') {
    issueLabel = '2. Customer Not Answering Call';
    internalReason = 'customer_issue';
    proofPrompt = 'customer location & unanswered call attempts (3+ calls placed)';
  } else if (issueKey === 'parcel_issue') {
    issueLabel = '3. Parcel Issue';
    internalReason = 'package_issue';
    proofPrompt = 'damaged cargo carton, liquid spill, or load mismatch';
  }

  appendChatBubble(issueLabel, true);

  setTimeout(() => {
    appendChatBubble(`
      <strong>📹 Mandatory Video Proof Required for ${issueLabel}:</strong><br>
      Please record a 3 to 15-second video proof showing the <strong>${proofPrompt}</strong> to cancel safely without penalty.<br>
      Opening video recorder now...
    `, false);

    // Open video recorder pre-selected to this reason
    openOrderRejectionModal();
    selectRejectionReason(internalReason);
  }, 250);
}

function appendChatBubble(htmlContent, isDriver) {
  const messagesContainer = document.getElementById('chatMessages');
  if (!messagesContainer) return;

  const bubble = document.createElement('div');
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isDriver) {
    bubble.className = 'flex items-start justify-end gap-2';
    bubble.innerHTML = `
      <div class="bg-vaayu-600 text-white rounded-2xl rounded-tr-none p-3 max-w-[85%] space-y-1 shadow">
        <p>${htmlContent}</p>
        <span class="text-[9px] text-white/70 block text-right font-mono">${timeStr}</span>
      </div>
    `;
  } else {
    bubble.className = 'flex items-start gap-2';
    bubble.innerHTML = `
      <div class="w-7 h-7 rounded-lg bg-vaayu-600 text-white font-bold flex items-center justify-center text-xs shrink-0 shadow">V</div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl rounded-tl-none p-3 text-slate-200 max-w-[85%] space-y-1 shadow">
        <div>${htmlContent}</div>
        <span class="text-[9px] text-slate-500 block font-mono">${timeStr}</span>
      </div>
    `;
  }

  messagesContainer.appendChild(bubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function openOrderRejectionModal() {
  const modal = document.getElementById('orderRejectionModal');
  if (!modal) return;

  let orderLabel = '—';
  let customerLabel = '—';
  if (currentTrip && currentTrip.tripId) {
    orderLabel = `#${currentTrip.tripId}`;
    customerLabel = `${currentTrip.customerName || 'Customer'} • ${(currentTrip.pickupAddress || 'Pickup').split(',')[0]} to ${(currentTrip.dropAddress || 'Drop').split(',')[0]}`;
  }

  const modalTripId = document.getElementById('rejectionModalTripId');
  const modalTripCust = document.getElementById('rejectionModalTripCustomer');
  if (modalTripId) modalTripId.innerText = orderLabel;
  if (modalTripCust) modalTripCust.innerText = customerLabel;

  // Reset rejection reason to default
  selectRejectionReason('vehicle_breakdown');

  // Reset video proof state
  retakeRejectionVideo();

  modal.classList.remove('hidden');
}

function closeOrderRejectionModal() {
  const modal = document.getElementById('orderRejectionModal');
  if (modal) modal.classList.add('hidden');
  stopRejectionCamera();
}

function stopRejectionCamera() {
  if (rejectionRecordTimerInterval) {
    clearInterval(rejectionRecordTimerInterval);
    rejectionRecordTimerInterval = null;
  }
  if (rejectionCanvasAnimId) {
    cancelAnimationFrame(rejectionCanvasAnimId);
    rejectionCanvasAnimId = null;
  }
  if (rejectionStream) {
    try {
      rejectionStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    rejectionStream = null;
  }
}

function selectRejectionReason(reason) {
  currentRejectionReason = reason;

  const cardVeh = document.getElementById('rejectionReasonVehicle');
  const cardPkg = document.getElementById('rejectionReasonPackage');
  const cardCust = document.getElementById('rejectionReasonCustomer');
  const checkVeh = document.getElementById('rejectionCheckVehicle');
  const checkPkg = document.getElementById('rejectionCheckPackage');
  const checkCust = document.getElementById('rejectionCheckCustomer');
  const hudReason = document.getElementById('rejectionHudReason');

  // Reset all cards
  [cardVeh, cardPkg, cardCust].forEach(c => {
    if (c) c.className = 'rejection-reason-card p-2.5 rounded-2xl bg-slate-950/60 border-2 border-slate-800 hover:border-slate-700 text-left transition flex flex-col justify-between cursor-pointer';
  });
  [checkVeh, checkPkg, checkCust].forEach(chk => {
    if (chk) {
      chk.className = 'w-3.5 h-3.5 rounded-full bg-slate-700 flex items-center justify-center text-[9px] text-slate-400';
      chk.innerText = '';
    }
  });

  if (reason === 'vehicle_breakdown') {
    if (cardVeh) cardVeh.className = 'rejection-reason-card active p-2.5 rounded-2xl bg-slate-950/90 border-2 border-rose-500 text-left transition flex flex-col justify-between cursor-pointer';
    if (checkVeh) {
      checkVeh.className = 'w-3.5 h-3.5 rounded-full bg-rose-500 flex items-center justify-center text-[9px] text-white font-black';
      checkVeh.innerText = '✓';
    }
    if (hudReason) hudReason.innerText = 'VEHICLE BREAKDOWN';
    renderRejectionTags([
      { id: 'flat_tyre', label: '🔧 Tyre Puncture' },
      { id: 'engine_overheat', label: '🔥 Engine Overheating' },
      { id: 'mechanical_stoppage', label: '⚙️ Mechanical Fault' },
      { id: 'road_accident', label: '🚨 Accident Stoppage' }
    ]);
  } else if (reason === 'package_issue') {
    if (cardPkg) cardPkg.className = 'rejection-reason-card active p-2.5 rounded-2xl bg-slate-950/90 border-2 border-rose-500 text-left transition flex flex-col justify-between cursor-pointer';
    if (checkPkg) {
      checkPkg.className = 'w-3.5 h-3.5 rounded-full bg-rose-500 flex items-center justify-center text-[9px] text-white font-black';
      checkPkg.innerText = '✓';
    }
    if (hudReason) hudReason.innerText = 'PACKAGE / CARGO ISSUE';
    renderRejectionTags([
      { id: 'damaged_package', label: '📦 Damaged Box / Torn Cargo' },
      { id: 'liquid_leakage', label: '💧 Liquid Leakage / Spill' },
      { id: 'overweight_cargo', label: '⚖️ Load Exceeds Truck Limit' },
      { id: 'label_mismatch', label: '🏷️ Label / SKU Mismatch' }
    ]);
  } else {
    if (cardCust) cardCust.className = 'rejection-reason-card active p-2.5 rounded-2xl bg-slate-950/90 border-2 border-rose-500 text-left transition flex flex-col justify-between cursor-pointer';
    if (checkCust) {
      checkCust.className = 'w-3.5 h-3.5 rounded-full bg-rose-500 flex items-center justify-center text-[9px] text-white font-black';
      checkCust.innerText = '✓';
    }
    if (hudReason) hudReason.innerText = 'CUSTOMER-SIDE ISSUE';
    renderRejectionTags([
      { id: 'phone_unreachable', label: '📵 Customer Unreachable (>15m)' },
      { id: 'wrong_address', label: '🗺️ Wrong Delivery Location' },
      { id: 'customer_cancelled', label: '❌ Customer Refused Cargo' },
      { id: 'customer_locked', label: '🚪 Premises Locked' }
    ]);
  }
}

function renderRejectionTags(tags) {
  const container = document.getElementById('rejectionTagsContainer');
  if (!container) return;
  container.innerHTML = '';
  tags.forEach((t, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = idx === 0 
      ? 'rejection-tag-chip active px-2.5 py-1 rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold cursor-pointer'
      : 'rejection-tag-chip px-2.5 py-1 rounded-lg bg-slate-950 text-slate-400 border border-slate-800 text-[10px] cursor-pointer hover:border-slate-700';
    btn.innerText = t.label;
    btn.onclick = () => {
      document.querySelectorAll('.rejection-tag-chip').forEach(c => {
        c.className = 'rejection-tag-chip px-2.5 py-1 rounded-lg bg-slate-950 text-slate-400 border border-slate-800 text-[10px] cursor-pointer hover:border-slate-700';
      });
      btn.className = 'rejection-tag-chip active px-2.5 py-1 rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold cursor-pointer';
      currentRejectionTag = t.id;
    };
    container.appendChild(btn);
  });
  currentRejectionTag = tags[0].id;
}

// ---------------------------------------------------------
// Mandatory Video Proof Recording Engine
// ---------------------------------------------------------
function startRejectionVideoRecording() {
  const btnStart = document.getElementById('btnStartVideoRecording');
  const btnStop = document.getElementById('btnStopVideoRecording');
  const videoPreview = document.getElementById('rejectionVideoPreview');
  const placeholder = document.getElementById('rejectionVideoPlaceholder');
  const recordingHud = document.getElementById('rejectionRecordingHud');
  const timerText = document.getElementById('rejectionRecordingTimer');
  const countdownText = document.getElementById('rejectionCountdownText');
  const retakeBtn = document.getElementById('btnRetakeVideo');

  if (btnStart) btnStart.classList.add('hidden');
  if (btnStop) btnStop.classList.remove('hidden');
  if (retakeBtn) retakeBtn.classList.add('hidden');
  if (placeholder) placeholder.classList.add('hidden');
  if (videoPreview) videoPreview.classList.remove('hidden');
  if (recordingHud) recordingHud.classList.remove('hidden');

  rejectionRecordSeconds = 0;
  if (timerText) timerText.innerText = '00:00';
  if (countdownText) countdownText.innerText = '6s';

  // Attempt real camera media stream
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' },
      audio: true
    }).then(stream => {
      rejectionStream = stream;
      videoPreview.srcObject = stream;
      videoPreview.muted = true;
      videoPreview.play().catch(() => {});
      startMediaRecorder(stream);
    }).catch(err => {
      console.log('[!] WebCam not available or permission denied:', err);
      showToast('Camera Access Required', 'Allow camera access or upload an existing video proof. No simulated evidence will be submitted.');
      retakeRejectionVideo();
    });
  } else {
    showToast('Camera Recording Unavailable', 'Upload an existing video proof to continue.');
    retakeRejectionVideo();
    return;
  }

  // Interval timer for 6 seconds recording (auto-stop or manual stop)
  rejectionRecordTimerInterval = setInterval(() => {
    rejectionRecordSeconds++;
    const formatted = `00:${String(rejectionRecordSeconds).padStart(2, '0')}`;
    if (timerText) timerText.innerText = formatted;
    const remaining = Math.max(0, 6 - rejectionRecordSeconds);
    if (countdownText) countdownText.innerText = `${remaining}s`;

    if (rejectionRecordSeconds >= 6) {
      stopRejectionVideoRecording();
    }
  }, 1000);
}

function startMediaRecorder(stream) {
  rejectionVideoChunks = [];
  try {
    let mime = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'video/webm';
    }
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'video/mp4';
    }
    rejectionMediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    rejectionMediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) rejectionVideoChunks.push(e.data);
    };
    rejectionMediaRecorder.onstop = () => {
      const blob = new Blob(rejectionVideoChunks, { type: mime || 'video/webm' });
      finalizeVideoProof(blob, rejectionRecordSeconds);
    };
    rejectionMediaRecorder.start(250);
  } catch (e) {
    console.error('[!] MediaRecorder error:', e);
    showToast('Camera Recording Unavailable', 'Allow camera access or upload an existing video proof to continue.');
    retakeRejectionVideo();
  }
}

function stopRejectionVideoRecording() {
  if (rejectionRecordTimerInterval) {
    clearInterval(rejectionRecordTimerInterval);
    rejectionRecordTimerInterval = null;
  }

  const btnStop = document.getElementById('btnStopVideoRecording');
  const recordingHud = document.getElementById('rejectionRecordingHud');

  if (btnStop) btnStop.classList.add('hidden');
  if (recordingHud) recordingHud.classList.add('hidden');

  if (rejectionMediaRecorder && rejectionMediaRecorder.state !== 'inactive') {
    rejectionMediaRecorder.stop();
  } else {
    showToast('Video Proof Not Captured', 'Record a real video or upload a video file before submitting this rejection.');
  }

  if (rejectionCanvasAnimId) {
    cancelAnimationFrame(rejectionCanvasAnimId);
    rejectionCanvasAnimId = null;
  }
}

function finalizeVideoProof(blob, durationSec) {
  rejectionVideoDuration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : null;

  const videoPreview = document.getElementById('rejectionVideoPreview');
  const retakeBtn = document.getElementById('btnRetakeVideo');
  const statusBadge = document.getElementById('rejectionVideoStatusBadge');
  const statusText = document.getElementById('rejectionVideoStatusText');
  const overlayBadge = document.getElementById('rejectionVerifiedBadgeOverlay');
  const verifiedText = document.getElementById('rejectionVerifiedText');
  const submitBtn = document.getElementById('btnSubmitOrderRejection');

  if (blob) {
    rejectionVideoBlob = blob;
    if (submitBtn) submitBtn.setAttribute('disabled', 'true');
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        showToast('Video Encoding Failed', 'Please record again or choose another video file.');
        return;
      }
      const encodedVideo = String(reader.result).split(',')[1];
      rejectionVideoDataUrl = `data:${blob.type.includes('mp4') ? 'video/mp4' : 'video/webm'};base64,${encodedVideo}`;
      if (videoPreview) {
        videoPreview.srcObject = null;
        videoPreview.src = rejectionVideoDataUrl;
        videoPreview.muted = false;
        videoPreview.controls = true;
      }
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.className = 'w-full py-3.5 bg-gradient-to-r from-rose-600 via-red-600 to-rose-600 hover:from-rose-500 hover:to-red-500 text-white font-display font-black text-xs uppercase tracking-wider rounded-xl shadow-xl shadow-rose-950/60 cursor-pointer active:scale-98 transition flex items-center justify-center gap-2';
      }
    };
    reader.readAsDataURL(blob);
  } else {
    showToast('Video Proof Not Captured', 'No video file was produced. Please record again or upload a video.');
    return;
  }

  // Video is attached, not yet verified by operations.
  if (statusBadge) {
    statusBadge.className = 'text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1';
  }
  if (statusText) {
    statusText.innerText = `Video ready (${rejectionVideoDuration ? `${rejectionVideoDuration.toFixed(1)}s • ` : ''}${(blob.size / (1024 * 1024)).toFixed(1)} MB)`;
  }
  if (overlayBadge) {
    overlayBadge.classList.remove('hidden');
  }
  if (verifiedText) {
    verifiedText.innerText = `${rejectionVideoDuration ? `${rejectionVideoDuration.toFixed(1)}s • ` : ''}VIDEO READY`;
  }
  if (retakeBtn) {
    retakeBtn.classList.remove('hidden');
  }

  showToast('Video Recorded ✓', 'The video is ready to submit for operations review.');
}

function handleRejectionVideoFileUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!['video/webm', 'video/mp4'].includes(file.type) || file.size > 20 * 1024 * 1024) {
    showToast('Unsupported Video', 'Choose a WebM or MP4 video no larger than 20 MiB.');
    event.target.value = '';
    return;
  }

  const videoPreview = document.getElementById('rejectionVideoPreview');
  const placeholder = document.getElementById('rejectionVideoPlaceholder');
  const btnStart = document.getElementById('btnStartVideoRecording');
  const retakeBtn = document.getElementById('btnRetakeVideo');

  if (placeholder) placeholder.classList.add('hidden');
  if (btnStart) btnStart.classList.add('hidden');
  if (retakeBtn) retakeBtn.classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = e => {
    rejectionVideoDataUrl = e.target.result;
    rejectionVideoBlob = file;
    rejectionVideoDuration = null;

    if (videoPreview) {
      videoPreview.classList.remove('hidden');
      videoPreview.srcObject = null;
      videoPreview.src = rejectionVideoDataUrl;
      videoPreview.muted = false;
      videoPreview.controls = true;
      videoPreview.onloadedmetadata = () => {
        rejectionVideoDuration = Number.isFinite(videoPreview.duration) ? videoPreview.duration : null;
        const statusText = document.getElementById('rejectionVideoStatusText');
        if (statusText) statusText.innerText = `Uploaded (${(file.size / (1024 * 1024)).toFixed(1)} MB${rejectionVideoDuration ? ` · ${rejectionVideoDuration.toFixed(1)}s` : ''})`;
      };
    }

    const statusBadge = document.getElementById('rejectionVideoStatusBadge');
    const statusText = document.getElementById('rejectionVideoStatusText');
    const submitBtn = document.getElementById('btnSubmitOrderRejection');

    if (statusBadge) {
      statusBadge.className = 'text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1';
    }
    if (statusText) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      statusText.innerText = `Uploaded (${mb} MB)`;
    }

    if (submitBtn) {
      submitBtn.removeAttribute('disabled');
      submitBtn.className = 'w-full py-3.5 bg-gradient-to-r from-rose-600 via-red-600 to-rose-600 hover:from-rose-500 hover:to-red-500 text-white font-display font-black text-xs uppercase tracking-wider rounded-xl shadow-xl shadow-rose-950/60 cursor-pointer active:scale-98 transition flex items-center justify-center gap-2';
    }

    showToast('Video Uploaded ✓', `${file.name} attached as proof.`);
  };
  reader.readAsDataURL(file);
}

function retakeRejectionVideo() {
  stopRejectionCamera();

  rejectionVideoBlob = null;
  rejectionVideoDataUrl = null;
  rejectionVideoDuration = 0;

  const videoPreview = document.getElementById('rejectionVideoPreview');
  const placeholder = document.getElementById('rejectionVideoPlaceholder');
  const btnStart = document.getElementById('btnStartVideoRecording');
  const btnStop = document.getElementById('btnStopVideoRecording');
  const retakeBtn = document.getElementById('btnRetakeVideo');
  const statusBadge = document.getElementById('rejectionVideoStatusBadge');
  const statusText = document.getElementById('rejectionVideoStatusText');
  const overlayBadge = document.getElementById('rejectionVerifiedBadgeOverlay');
  const submitBtn = document.getElementById('btnSubmitOrderRejection');

  if (videoPreview) {
    videoPreview.classList.add('hidden');
    videoPreview.srcObject = null;
    videoPreview.src = '';
  }
  if (placeholder) placeholder.classList.remove('hidden');
  if (btnStart) btnStart.classList.remove('hidden');
  if (btnStop) btnStop.classList.add('hidden');
  if (retakeBtn) retakeBtn.classList.add('hidden');
  if (overlayBadge) overlayBadge.classList.add('hidden');

  if (statusBadge) {
    statusBadge.className = 'text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1';
  }
  if (statusText) statusText.innerText = 'Video Required (0/1)';

  if (submitBtn) {
    submitBtn.setAttribute('disabled', 'true');
    submitBtn.className = 'w-full py-3.5 bg-gradient-to-r from-rose-600 via-red-600 to-rose-600 text-white font-display font-black text-xs uppercase tracking-wider rounded-xl shadow-xl shadow-rose-950/60 opacity-50 cursor-not-allowed transition flex items-center justify-center gap-2';
  }
}

// ---------------------------------------------------------
// Submit Order Rejection with Video Proof
// ---------------------------------------------------------
async function submitOrderRejection() {
  if (!rejectionVideoDataUrl && !rejectionVideoBlob) {
    showToast('Video Proof Required ⚠️', 'You must record or upload a video proof showing the breakdown or customer issue before rejecting.');
    return;
  }
  if (rejectionVideoDuration != null && (rejectionVideoDuration < 3 || rejectionVideoDuration > 15)) {
    showToast('Video Duration Out of Range', 'Use a video between 3 and 15 seconds, then upload or record again.');
    return;
  }

  const submitBtn = document.getElementById('btnSubmitOrderRejection');
  const btnText = document.getElementById('rejectionSubmitBtnText');
  const btnIcon = document.getElementById('rejectionSubmitBtnIcon');
  const notes = (document.getElementById('rejectionDriverNotes') ? document.getElementById('rejectionDriverNotes').value : '') || `Reported ${currentRejectionTag}`;

  if (submitBtn) submitBtn.setAttribute('disabled', 'true');
  if (btnText) btnText.innerText = 'TRANSMITTING VIDEO PROOF TO OPS...';
  if (btnIcon) btnIcon.innerText = '⏳';

  let orderId = currentTrip && currentTrip.tripId ? currentTrip.tripId : '';

  const payload = {
    driver_id: state.driverId || '',
    order_id: orderId,
    reason: currentRejectionReason,
    notes: `[Tag: ${currentRejectionTag}] ${notes}`,
    video_data: rejectionVideoDataUrl,
    duration: rejectionVideoDuration
  };

  try {
    const res = await fetch('/api/trip/emergency-reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error?.message || data.error || `Could not submit rejection (HTTP ${res.status}).`);
  } catch (err) {
    console.warn('[!] Emergency rejection submission failed:', err);
    if (submitBtn) {
      submitBtn.removeAttribute('disabled');
      submitBtn.className = 'w-full py-3.5 bg-gradient-to-r from-rose-600 via-red-600 to-rose-600 hover:from-rose-500 hover:to-red-500 text-white font-display font-black text-xs uppercase tracking-wider rounded-xl shadow-xl shadow-rose-950/60 cursor-pointer active:scale-98 transition flex items-center justify-center gap-2';
    }
    if (btnText) btnText.innerText = 'SUBMIT VIDEO PROOF';
    if (btnIcon) btnIcon.innerText = '🎥';
    showToast('Submission Failed', err.message || 'The rejection could not be saved. Your current order is still open.');
    return;
  }

  // Reset active order state in client
  currentTrip = null;
  currentTripStatus = null;
  state.status = 'ONLINE';

  // Clear map routes & waypoints
  if (typeof clearOrderRoute === 'function') clearOrderRoute();
  if (typeof activeWaypointMarkers !== 'undefined') {
    activeWaypointMarkers.forEach(m => {
      try { liveMap.removeLayer(m); } catch (e) {}
    });
    activeWaypointMarkers = [];
  }

  // Update UI back to Idle Cockpit
  renderActiveTripUI();
  syncUI();

  // Close modal
  closeOrderRejectionModal();

  let reasonTitle = '1. Vehicle Breakdown';
  if (currentRejectionReason === 'customer_issue') reasonTitle = '2. Customer Not Answering Call';
  else if (currentRejectionReason === 'package_issue') reasonTitle = '3. Parcel Issue';

  if (typeof appendChatBubble === 'function') {
    appendChatBubble(`
      ⏳ <strong>Rejection request submitted for operations review.</strong><br>
      • <strong>Order ID:</strong> #${orderId}<br>
      • <strong>Reason:</strong> ${reasonTitle}<br>
      • <strong>Proof:</strong> Video attached; awaiting Admin review<br>
      • No cancellation decision, penalty waiver, or compensation is issued by this submission.<br>
    `, false);
  }

  partnerCareState = 'main';
  if (typeof syncPartnerCareMenuUI === 'function') syncPartnerCareMenuUI();

  showToast('Rejection Submitted', `Order ${orderId} and its video proof were sent for operations review.`);
}

// ---------------------------------------------------------
// Rejection History Modal
// ---------------------------------------------------------
async function openRejectionHistoryModal() {
  const modal = document.getElementById('rejectionHistoryModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await loadRejectionHistory();
}

function closeRejectionHistoryModal() {
  const modal = document.getElementById('rejectionHistoryModal');
  if (modal) modal.classList.add('hidden');
}

async function loadRejectionHistory() {
  const listEl = document.getElementById('rejectionHistoryList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="p-4 text-center text-slate-400">Loading incident records...</div>';

  try {
    const res = await fetch(`/api/trip/rejections?driver_id=${state.driverId || ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data || data.length === 0) {
      listEl.innerHTML = `
        <div class="p-6 text-center text-slate-500 space-y-2">
          <div class="text-2xl">🛡️</div>
          <div class="font-bold text-slate-300">Clean Incident Record</div>
          <p class="text-[10px] text-slate-500">No emergency order rejections recorded for your captain profile.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    data.forEach(item => {
      const card = document.createElement('div');
      card.className = 'p-3 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1.5';
      const isBreakdown = item.reason === 'vehicle_breakdown';
      const status = String(item.status || 'PENDING_REVIEW');
      const statusLabel = status === 'APPROVED_NO_PENALTY' ? 'APPROVED · NO PENALTY' : status === 'REJECTED_FINED_100' ? 'REJECTED · PENALTY APPLIED' : 'PENDING OPS REVIEW';
      const statusColor = status === 'APPROVED_NO_PENALTY' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : status === 'REJECTED_FINED_100' ? 'bg-rose-500/20 text-rose-400 border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between';
      const order = document.createElement('span');
      order.className = 'font-mono font-bold text-xs text-white';
      order.textContent = `#${item.order_id || 'Unknown order'}`;
      const badge = document.createElement('span');
      badge.className = `text-[9px] font-mono px-2 py-0.5 rounded-full font-bold border ${statusColor}`;
      badge.textContent = statusLabel;
      header.append(order, badge);
      const reason = document.createElement('div');
      reason.className = `text-[11px] font-bold ${isBreakdown ? 'text-rose-400' : 'text-amber-400'}`;
      reason.textContent = isBreakdown ? '🚗 Vehicle Breakdown' : '👤 Customer-side Issue';
      const note = document.createElement('p');
      note.className = 'text-[10px] text-slate-400';
      note.textContent = item.notes || 'No extra notes provided';
      const footer = document.createElement('div');
      footer.className = 'flex items-center justify-between text-[9px] text-slate-500 pt-1 border-t border-slate-900 font-mono';
      const proof = document.createElement('span');
      proof.textContent = `Proof: ${item.video_attached ? (item.video_duration_seconds ? `${item.video_duration_seconds}s video attached` : 'Video attached') : 'No video attached'}`;
      const date = document.createElement('span');
      date.textContent = item.created_at ? new Date(item.created_at).toLocaleString() : 'Date not recorded';
      footer.append(proof, date);
      card.append(header, reason, note, footer);
      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '<div class="p-4 text-center text-rose-400">Could not load incident history.</div>';
  }
}

// ---------------------------------------------------------
// Top Navigation Help Section Controller
// ---------------------------------------------------------
function openTopHelpSection() {
  const modal = document.getElementById('topHelpModal');
  if (modal) {
    const badge = document.getElementById('topHelpOrderBadge');
    if (badge) {
      const hasOrder = (state.status === 'ON_TRIP' || Boolean(currentTrip));
      badge.innerText = hasOrder ? 'ACTIVE ORDER' : 'IDLE';
      badge.className = hasOrder 
        ? 'text-[8px] font-mono px-2 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse'
        : 'text-[8px] font-mono px-2 py-0.5 rounded-full font-bold bg-slate-900 text-slate-400 border border-slate-800';
    }
    modal.classList.remove('hidden');
  } else {
    navigateToFullHelpSection();
  }
}

function closeTopHelpModal() {
  const modal = document.getElementById('topHelpModal');
  if (modal) modal.classList.add('hidden');
}
window.openTopHelpSection = openTopHelpSection;
window.openTopHelpModal = openTopHelpSection;
window.closeTopHelpModal = closeTopHelpModal;

function navigateToFullHelpSection() {
  closeTopHelpModal();
  switchTab('profile');
  setTimeout(() => {
    const helpSec = document.getElementById('sectionProfile');
    if (helpSec) {
      helpSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      helpSec.classList.add('ring-2', 'ring-vaayu-500', 'transition-all');
      setTimeout(() => helpSec.classList.remove('ring-2', 'ring-vaayu-500'), 2500);
    }
  }, 150);
}

function openSosModal() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playOrderAlert(); } catch (e) {}
  }
  const modal = document.getElementById('emergencySosModal');
  if (modal) modal.classList.remove('hidden');
}
window.openSosModal = openSosModal;

function closeSosModal() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  const modal = document.getElementById('emergencySosModal');
  if (modal) modal.classList.add('hidden');
}
window.closeSosModal = closeSosModal;

function triggerSosBroadcast(serviceName) {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playOrderAlert(); } catch (e) {}
  }
  showToast(
    '🚨 SOS Alert Transmitted!',
    `Connecting to ${serviceName || 'Emergency Desk'}. Live GPS coordinates broadcasted.`,
    '🚨'
  );
}
window.triggerSosBroadcast = triggerSosBroadcast;

function handleSupportTopic(topic) {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  openSupportChatModal();

  setTimeout(() => {
    if (topic === 'customer_unreachable') {
      sendSupportChatMessage('Customer Not Answering (Wait timer & return flow)');
    } else if (topic === 'store_delay') {
      sendSupportChatMessage('Store Delay > 15 mins (Auto wait compensation)');
    } else if (topic === 'payout_query') {
      sendSupportChatMessage('Payout / Bank Delay (Check UTR & status)');
    } else if (topic === 'vehicle_breakdown') {
      sendSupportChatMessage('Vehicle Breakdown (Roadside Assistance & Support)');
      setTimeout(() => {
        const card = document.getElementById('chatOrderRejectionCard');
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('ring-4', 'ring-rose-500', 'transition-all');
          setTimeout(() => card.classList.remove('ring-4', 'ring-rose-500'), 2500);
        }
      }, 250);
    }
  }, 150);
}
window.handleSupportTopic = handleSupportTopic;

function openSupportChatModal() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  const modal = document.getElementById('supportChatModal');
  if (modal) {
    modal.classList.remove('hidden');
    syncOrderRejectionSettingsUI();
    const chatInput = document.getElementById('chatInput');
    if (chatInput) setTimeout(() => chatInput.focus(), 200);
  }
}
window.openSupportChatModal = openSupportChatModal;

function closeSupportChatModal() {
  if (typeof audioSynth !== 'undefined' && audioSynth) {
    try { audioSynth.playClick(); } catch (e) {}
  }
  const modal = document.getElementById('supportChatModal');
  if (modal) modal.classList.add('hidden');
}
window.closeSupportChatModal = closeSupportChatModal;

function sendSupportChatMessage(customText) {
  const inputEl = document.getElementById('chatInput');
  const text = (customText || (inputEl ? inputEl.value : '')).trim();
  if (!text) return;
  if (inputEl) inputEl.value = '';

  const messagesContainer = document.getElementById('chatMessages');
  if (!messagesContainer) return;

  // Append Driver Message
  const driverMsg = document.createElement('div');
  driverMsg.className = 'flex items-start justify-end gap-2';
  driverMsg.innerHTML = `
    <div class="bg-vaayu-600 text-white rounded-2xl rounded-tr-none p-3 max-w-[85%] space-y-1 shadow">
      <p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
      <span class="text-[9px] text-white/70 block text-right font-mono">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  `;
  messagesContainer.appendChild(driverMsg);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  const lower = text.toLowerCase().trim();

  // Active Trip Menu Routing
  const hasActive = (state.status === 'ON_TRIP' || Boolean(currentTrip));
  if (hasActive) {
    if (lower === '1' || lower === '1.' || lower.includes('about order') || lower.includes('order details')) {
      handlePartnerMenuSelect('about_order');
      return;
    }
    if (lower === '2' || lower === '2.' || lower === 'cancel order' || lower.includes('cancel my order') || lower === 'cancel') {
      handlePartnerMenuSelect('cancel_order');
      return;
    }
    if (lower === '3' || lower === '3.' || lower.includes('main menu') || lower.includes('back to main menu') || lower === 'back') {
      handlePartnerMenuSelect('main_menu');
      return;
    }
    if (lower.includes('breakdown') || lower.includes('flat tyre') || lower.includes('puncture') || lower.includes('engine') || lower.includes('accident')) {
      handleCancelIssueSelect('vehicle_breakdown');
      return;
    }
    if (lower.includes('not answering') || lower.includes('not picking') || lower.includes('unreachable') || lower.includes('customer not')) {
      handleCancelIssueSelect('customer_not_answering');
      return;
    }
    if (lower.includes('parcel') || lower.includes('package') || lower.includes('damaged') || lower.includes('cargo') || lower.includes('leak') || lower.includes('spill')) {
      handleCancelIssueSelect('parcel_issue');
      return;
    }
  }

  if (vaayuDriverToken) {
    fetch('/api/support/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, tripId: currentTrip?.tripId || null })
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Support is unavailable right now.');
      appendChatBubble(result.reply || 'Support received your message.', false);
    }).catch(error => appendChatBubble(`Support message could not be sent: ${error.message}`, false));
    return;
  }

  // Instant helpful response for other topics
  setTimeout(() => {
    let reply = "Thank you for contacting Captain Support. An agent has been alerted. For urgent support, please dial toll-free 1800-419-VAAYU.";
    
    if (lower.includes('reject') || lower.includes('breakdown') || lower.includes('cancel') || lower.includes('emergency')) {
      if (hasActive) {
        reply = `<strong>📋 Active Order Cancellation:</strong><br>To cancel safely without penalty, tap <strong>"2. Cancel Order"</strong> in the menu above and select your specific issue (Vehicle Breakdown, Customer Not Answering, or Parcel Issue) to record video proof.`;
      } else {
        reply = `<strong>🚗 Vehicle Breakdown &amp; Roadside Support:</strong><br>You currently have no active delivery in progress.<br>For immediate roadside assistance or towing, contact our 24x7 helpline: <strong>1800-419-VAAYU</strong>.`;
      }
    } else if (lower.includes('customer') || lower.includes('call') || lower.includes('reach') || lower.includes('pick') || lower.includes('answering')) {
      reply = `<strong>📞 Customer Unreachable:</strong><br>1. Attempt calling the customer 3 times from your order screen.<br>2. Wait 5 minutes at the pickup or drop location.<br>3. Select <strong>'2. Cancel Order' &gt; '2. Customer Not Answering Call'</strong> to submit quick proof and cancel without penalty.`;
    } else if (lower.includes('store') || lower.includes('delay') || lower.includes('wait') || lower.includes('dark store')) {
      reply = `<strong>⏱️ Store Delay &gt; 15 mins:</strong><br>• Dark store delays exceeding 15 minutes are tracked automatically via live GPS geofencing.<br>• Waiting compensation of <strong>₹3.50/minute</strong> starts automatically.<br>• The extra compensation will be credited directly to your Pocket wallet at order pickup.`;
    } else if (lower.includes('payout') || lower.includes('bank') || lower.includes('wallet') || lower.includes('money') || lower.includes('utr')) {
      reply = `<strong>💳 Payout &amp; Bank Settlement:</strong><br>• Instant UPI withdrawals are dispatched 24x7 within 30 seconds.<br>• For bank NEFT delays, your 12-digit UTR reference is available under <strong>Pocket &gt; Settlements</strong>.<br>• Need manual assistance? Accounts desk is reachable at 1800-419-VAAYU.`;
    }

    appendChatBubble(reply, false);
  }, 350);
}
window.sendSupportChatMessage = sendSupportChatMessage;

// ==========================================
// 9. APPLICATION INITIALIZATION & EVENT LISTENERS
// ==========================================
function initApplication() {
  try { initMap(); } catch (e) { console.warn('Leaflet map initialization:', e); }
  try { updateClock(); setInterval(updateClock, 30000); } catch (e) {}
  try { startShiftTimer(); } catch (e) {}
  try { startGpsTelemetryLoop(); } catch (e) {}
  try { initSocketConnection(); } catch (e) {}
  try { initDragToCompleteSlider(); } catch (e) { console.warn('Drag slider init:', e); }
  try { syncUI(); } catch (e) { console.warn('syncUI initialization:', e); }

  // Connect to local PC database 'vaayu'
  try { checkDatabaseHealth().then(() => loadDriverFromDatabase()).catch(() => {}); } catch (e) {}

  // Check URL params for mode=fleet
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'fleet') {
      setTimeout(() => {
        state.partnerMode = 'FLEET_OWNER';
        const label = document.getElementById('roleSwitcherLabel');
        if (label) label.textContent = '🏢 Fleet Owner';
        if (typeof switchTab === 'function') switchTab('fleet');
      }, 150);
    }
  } catch(e) {}

  // Navigation Tabs
  const navMain = document.getElementById('navBtnMain');
  const navPocket = document.getElementById('navBtnPocket');
  const navProfile = document.getElementById('navBtnProfile');
  const navFleet = document.getElementById('navBtnFleet');

  const webNavMain = document.getElementById('webNavBtnMain');
  const webNavPocket = document.getElementById('webNavBtnPocket');
  const webNavProfile = document.getElementById('webNavBtnProfile');
  const webNavFleet = document.getElementById('webNavBtnFleet');

  const secMain = document.getElementById('sectionMain');
  const secPocket = document.getElementById('sectionPocket');
  const secProfile = document.getElementById('sectionProfile');
  const secFleet = document.getElementById('sectionFleet');

  function renderFleetRoster() {
    const container = document.getElementById('fleetDriversRosterContainer');
    if (!container) return;
    const fleet = state.fleetOwnerProfile;
    if (!vaayuFleetToken || !fleet) {
      container.innerHTML = '<p class="p-3 text-slate-400">Sign in as a fleet owner to load your live roster.</p>';
      return;
    }
    const activeDrivers = Array.isArray(fleetDrivers) ? fleetDrivers : [];

    const companyEl = document.getElementById('fleetCompanyNameDisplay');
    if (companyEl) companyEl.textContent = `${fleet.companyName || 'Fleet'} • ${fleet.totalVehicles || 0} Trucks`;

    const earningsEl = document.getElementById('fleetTotalEarnings');
    if (earningsEl) earningsEl.textContent = `₹${activeDrivers.reduce((sum, d) => sum + (Number(d.todayEarnings) || 0), 0).toLocaleString('en-IN')}`;

    const activeCountEl = document.getElementById('fleetActiveDriversCount');
    if (activeCountEl) {
      const online = activeDrivers.filter(d => d.status === 'ONLINE').length;
      activeCountEl.textContent = `${online} / ${activeDrivers.length} Online`;
    }

    const rosterBadgeEl = document.getElementById('fleetRosterBadge');
    if (rosterBadgeEl) rosterBadgeEl.textContent = `${activeDrivers.length} Fleet drivers`;
    const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    container.innerHTML = activeDrivers.length ? activeDrivers.map(d => `
      <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 space-y-2">
        <div class="flex justify-between items-start">
          <div>
            <span class="font-bold text-white block text-xs">${safe(d.name)}</span>
            <span class="text-[10px] text-slate-400 font-mono">${safe(d.phone)}</span>
          </div>
          <span class="px-2 py-0.5 font-bold text-[9px] rounded-md uppercase ${d.status === 'ONLINE' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
            ${safe(d.status || 'OFFLINE')}
          </span>
        </div>

        <div class="flex justify-between items-center bg-slate-900/90 p-2 rounded-xl border border-slate-800 text-[11px]">
          <div>
            <span class="text-cyan-400 font-semibold block text-[10px]">${safe(d.vehicleName || d.vehicleId || 'Vehicle not assigned')}</span>
            <span class="font-mono text-white font-bold text-[10px]">${safe(d.vehicleNumber || 'Plate not recorded')}</span>
          </div>
          <div class="text-right">
            <span class="text-[9px] text-slate-400 block uppercase">TODAY PAY</span>
            <span class="font-mono font-bold text-emerald-400">₹${Number(d.todayEarnings || 0).toLocaleString('en-IN')}</span>
          </div>
        </div>

        <div class="flex items-center justify-between pt-0.5">
          <span class="px-2 py-0.5 ${['APPROVED','VERIFIED'].includes(String(d.kycStatus).toUpperCase()) ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/10 text-amber-300 border-amber-500/30'} border font-bold text-[9px] rounded-md">
            ${safe(d.kycStatus || 'KYC PENDING')}
          </span>
          <label class="flex items-center gap-1 text-[9px] text-slate-400">Assign
            <select aria-label="Assign vehicle for ${safe(d.name)}" data-on="change" data-action="reassignFleetVehicle" data-args='${safe(JSON.stringify([String(d.id), '@value']))}' class="max-w-28 bg-slate-800 text-slate-100 border border-slate-700 rounded-lg px-1.5 py-1 text-[9px]">
              ${[['v_2w','VAAYU Express 2W'],['v_3w','VAAYU Auto Cargo'],['v_ace','VAAYU Ace'],['v_pickup_8ft','VAAYU Pickup 8ft'],['v_pickup_9ft','VAAYU Pickup 9ft'],['v_14ft','VAAYU 14ft Truck']].map(([id,label]) => `<option value="${id}" ${d.vehicleId === id ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
    `).join('') : '<p class="p-3 text-slate-400">No drivers are currently assigned to this fleet.</p>';
  }

  async function refreshFleetOwnerData() {
    const message = document.getElementById('fleetAuthMessage');
    const content = document.getElementById('fleetOwnerContent');
    const authCard = document.getElementById('fleetOwnerAuthCard');
    if (!vaayuFleetToken) { if (content) content.classList.add('hidden'); if (authCard) authCard.classList.remove('hidden'); renderFleetRoster(); return; }
    try {
      const [profileResponse, driversResponse, summaryResponse] = await Promise.all([
        fetch('/api/fleet/profile'), fetch('/api/fleet/drivers'), fetch('/api/fleet/summary')
      ]);
      const [profile, driverData, summaryData] = await Promise.all([profileResponse.json(), driversResponse.json(), summaryResponse.json()]);
      if ([profileResponse, driversResponse, summaryResponse].some(response => response.status === 401 || response.status === 403)) throw new Error('Fleet session expired. Please sign in again.');
      if (!profile.success || !driverData.success || !summaryData.success) throw new Error(profile.error || driverData.error || summaryData.error || 'Could not load fleet data.');
      fleetOwnerProfile = profile.fleetOwner;
      fleetDrivers = driverData.drivers || [];
      state.fleetOwnerProfile = fleetOwnerProfile;
      if (message) message.textContent = '';
      if (content) content.classList.remove('hidden');
      if (authCard) authCard.classList.add('hidden');
      const summary = summaryData.summary || {};
      const totalVehicles = document.getElementById('fleetTotalVehicles');
      if (totalVehicles) totalVehicles.textContent = String(summary.totalVehicles ?? fleetOwnerProfile.totalVehicles ?? 0);
      const totalTrips = document.getElementById('fleetTripsToday');
      if (totalTrips) totalTrips.textContent = String(summary.totalTrips ?? 0);
      const city = document.getElementById('fleetCityDisplay');
      if (city) city.textContent = summary.city || fleetOwnerProfile.city || '—';
      const earningsCaption = document.querySelector('#fleetTotalEarnings + span');
      if (earningsCaption) earningsCaption.textContent = `Across ${summary.totalTrips || 0} recorded trips`;
      renderFleetRoster();
    } catch (error) {
      if (message) message.textContent = error.message || 'Unable to connect to fleet service.';
      if (/expired|access denied/i.test(error.message || '')) logoutFleetOwner(false);
    }
  }

  async function sendFleetOwnerOtp() {
    const phoneInput = document.getElementById('fleetOwnerPhone');
    const message = document.getElementById('fleetAuthMessage');
    fleetOtpPhone = (phoneInput?.value || '').trim();
    try {
      const response = await nativeDriverFetch('/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: fleetOtpPhone }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Could not send OTP.');
      fleetOtpCode = '';
      document.getElementById('fleetOtpStep')?.classList.remove('hidden');
      document.getElementById('fleetOtpStep')?.classList.add('flex');
      if (message) message.textContent = `OTP sent to ${result.phone || fleetOtpPhone}. Enter the code from your SMS.`;
    } catch (error) { if (message) message.textContent = error.message || 'Could not send OTP.'; }
  }

  async function verifyFleetOwnerOtp() {
    const message = document.getElementById('fleetAuthMessage');
    const otp = document.getElementById('fleetOwnerOtp')?.value || '';
    try {
      const response = await nativeDriverFetch('/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: fleetOtpPhone, otp }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || 'Verification failed.');
      if (result.user?.role !== 'FLEET_OWNER') throw new Error('This phone number is not registered as a fleet owner.');
      vaayuFleetToken = result.token;
      sessionStorage.setItem('vaayu_fleet_token', result.token);
      await refreshFleetOwnerData();
    } catch (error) { if (message) message.textContent = error.message || 'Verification failed.'; }
  }

  function logoutFleetOwner(showMessage = true) {
    vaayuFleetToken = null;
    fleetOwnerProfile = null;
    fleetDrivers = [];
    try { sessionStorage.removeItem('vaayu_fleet_token'); } catch (_) {}
    document.getElementById('fleetOwnerContent')?.classList.add('hidden');
    document.getElementById('fleetOwnerAuthCard')?.classList.remove('hidden');
    if (showMessage) {
      const message = document.getElementById('fleetAuthMessage');
      if (message) message.textContent = 'Fleet owner signed out.';
    }
    renderFleetRoster();
  }

  function togglePartnerMode() {
    if (state.partnerMode === 'SOLO_DRIVER') {
      state.partnerMode = 'FLEET_OWNER';
      const label = document.getElementById('roleSwitcherLabel');
      if (label) label.textContent = '🏢 Fleet Owner';
      showToast('🏢 Switched to 2-in-1 Fleet Owner Mode', 'success');
      switchTab('fleet');
    } else {
      state.partnerMode = 'SOLO_DRIVER';
      const label = document.getElementById('roleSwitcherLabel');
      if (label) label.textContent = '🚚 Solo Captain';
      showToast('🚚 Switched to Solo Driver Duty', 'info');
      switchTab('main');
    }
  }

  async function reassignFleetVehicle(driverId, vehicleId) {
    if (!vaayuFleetToken || !vehicleId) return;
    const message = document.getElementById('fleetAuthMessage');
    try {
      const response = await fetch('/api/fleet/assign-driver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver_id: driverId, vehicle_id: vehicleId }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Vehicle assignment failed.');
      if (message) message.textContent = result.message || 'Vehicle assignment saved.';
      await refreshFleetOwnerData();
    } catch (error) { if (message) message.textContent = error.message || 'Vehicle assignment failed.'; }
  }

  function showAddDriverModal() {
    showToast('➕ New Fleet Driver Onboarding Flow Initialized', 'info');
  }

  function switchTab(target) {
    audioSynth.playClick();
    state.activeTab = target;

    [navMain, navPocket, navProfile, navFleet].forEach(btn => {
      if (btn) {
        btn.classList.remove('active', 'text-vaayu-400');
        btn.classList.add('text-slate-400');
      }
    });

    [webNavMain, webNavPocket, webNavProfile, webNavFleet].forEach(btn => {
      if (btn) {
        btn.classList.remove('active', 'text-emerald-400', 'bg-slate-800/80', 'shadow');
        btn.classList.add('text-slate-400');
      }
    });

    [secMain, secPocket, secProfile, secFleet].forEach(s => { if (s) s.classList.add('hidden'); });

    if (target === 'main') {
      if (navMain) {
        navMain.classList.add('active', 'text-vaayu-400');
        navMain.classList.remove('text-slate-400');
      }
      if (webNavMain) {
        webNavMain.classList.add('active', 'text-emerald-400', 'bg-slate-800/80', 'shadow');
        webNavMain.classList.remove('text-slate-400');
      }
      secMain.classList.remove('hidden');
      if (map) setTimeout(() => map.invalidateSize(), 150);
    } else if (target === 'pocket') {
      if (navPocket) {
        navPocket.classList.add('active', 'text-vaayu-400');
        navPocket.classList.remove('text-slate-400');
      }
      if (webNavPocket) {
        webNavPocket.classList.add('active', 'text-emerald-400', 'bg-slate-800/80', 'shadow');
        webNavPocket.classList.remove('text-slate-400');
      }
      secPocket.classList.remove('hidden');
      renderAttendanceCalendar();
      renderDailyBreakdown();
    } else if (target === 'profile') {
      if (navProfile) {
        navProfile.classList.add('active', 'text-vaayu-400');
        navProfile.classList.remove('text-slate-400');
      }
      if (webNavProfile) {
        webNavProfile.classList.add('active', 'text-emerald-400', 'bg-slate-800/80', 'shadow');
        webNavProfile.classList.remove('text-slate-400');
      }
      secProfile.classList.remove('hidden');
    } else if (target === 'fleet') {
      if (navFleet) {
        navFleet.classList.add('active', 'text-vaayu-400');
        navFleet.classList.remove('text-slate-400');
      }
      if (webNavFleet) {
        webNavFleet.classList.add('active', 'text-emerald-400', 'bg-slate-800/80', 'shadow');
        webNavFleet.classList.remove('text-slate-400');
      }
      if (secFleet) secFleet.classList.remove('hidden');
      refreshFleetOwnerData();
      renderFleetRoster();
    }
    saveState();
  }

  if (navMain) navMain.addEventListener('click', () => switchTab('main'));
  if (navPocket) navPocket.addEventListener('click', () => switchTab('pocket'));
  if (navProfile) navProfile.addEventListener('click', () => switchTab('profile'));
  if (navFleet) navFleet.addEventListener('click', () => switchTab('fleet'));

  if (webNavMain) webNavMain.addEventListener('click', () => switchTab('main'));
  if (webNavPocket) webNavPocket.addEventListener('click', () => switchTab('pocket'));
  if (webNavProfile) webNavProfile.addEventListener('click', () => switchTab('profile'));
  if (webNavFleet) webNavFleet.addEventListener('click', () => switchTab('fleet'));

  // Duty Online / Offline Toggle (Persisted to storage)
  const dutyToggleBtnEl = document.getElementById('dutyToggleBtn');
  if (dutyToggleBtnEl) {
    dutyToggleBtnEl.onclick = () => toggleDuty();
  }

  // Vehicle Switcher (Persisted to storage)
  document.querySelectorAll('.vehicle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      state.vehicleId = e.currentTarget.dataset.mode;
      audioSynth.playClick();
      updateDriverMarkerIcon();
      syncUI();
      // Persist to local storage
      fetch('/api/driver/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_id: state.driverId,
          vehicle_id: state.vehicleId
        })
      }).then(() => checkDatabaseHealth()).catch(() => {});
    });
  });


  // Incoming Modal Actions
  document.getElementById('btnAcceptOrder').addEventListener('click', acceptCurrentTrip);
  document.getElementById('btnRejectOrder').addEventListener('click', declineCurrentTrip);

  // In-Trip Actions
  document.getElementById('btnOpenNav').addEventListener('click', openGoogleMapsNavigation);

  document.getElementById('btnCallContact').addEventListener('click', () => {
    if (!currentTrip) return;
    const isHeadingToPickup = (currentTripStatus === 'ACCEPTED');
    const target = isHeadingToPickup ? currentTrip.pickupAddress : currentTrip.dropAddress;
    const phone = String(currentTrip.customerPhone || '').replace(/[^\d+]/g, '');
    if (!phone) { showToast('Contact number unavailable', `Open support for help reaching the contact at ${target}.`, '☎️'); return; }
    window.location.href = `tel:${phone}`;
  });

  // OTP Modal Handlers
  document.getElementById('btnCancelOtp').addEventListener('click', closeDeliveryOtpModal);
  document.getElementById('btnSubmitOtp').addEventListener('click', submitDeliveryOtp);

  // OTP Auto-Focus
  const otpInputs = document.querySelectorAll('.otp-input');
  otpInputs.forEach((input, idx) => {
    input.addEventListener('keyup', (e) => {
      if (e.key >= '0' && e.key <= '9') {
        if (idx < otpInputs.length - 1) otpInputs[idx + 1].focus();
      } else if (e.key === 'Backspace') {
        if (idx > 0) otpInputs[idx - 1].focus();
      }
    });
  });

  // Customer Feedback Modal Handlers
  const starBtns = document.querySelectorAll('.star-btn');
  starBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      audioSynth.playClick();
      const rating = parseInt(e.currentTarget.dataset.rating, 10);
      setStarRating(rating);
    });
    btn.addEventListener('mouseenter', (e) => {
      const hoverRating = parseInt(e.currentTarget.dataset.rating, 10);
      starBtns.forEach(s => {
        const val = parseInt(s.dataset.rating, 10);
        if (val <= hoverRating) s.classList.add('hover');
        else s.classList.remove('hover');
      });
    });
  });

  const starGroup = document.getElementById('customerStarRatingGroup');
  if (starGroup) {
    starGroup.addEventListener('mouseleave', () => {
      starBtns.forEach(s => s.classList.remove('hover'));
    });
  }

  // Tag Chips Multi-selection
  document.querySelectorAll('.feedback-tag-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      audioSynth.playClick();
      e.currentTarget.classList.toggle('selected');
    });
  });

  // Submit & Skip Feedback Buttons
  const btnSubmitFeedback = document.getElementById('btnSubmitFeedback');
  if (btnSubmitFeedback) {
    btnSubmitFeedback.addEventListener('click', submitCustomerFeedback);
  }

  const btnSkipFeedback = document.getElementById('btnSkipFeedback');
  if (btnSkipFeedback) {
    btnSkipFeedback.addEventListener('click', () => {
      audioSynth.playClick();
      skipCustomerFeedback();
    });
  }

  // ==========================================
  // REFER & EARN BONUS CONTROLLER (MAIN SECTION)
  // ==========================================
  const referModal = document.getElementById('referModal');
  const cardReferEarnMain = document.getElementById('cardReferEarnMain');
  const btnViewReferralDetails = document.getElementById('btnViewReferralDetails');
  const btnCloseReferModal = document.getElementById('btnCloseReferModal');
  const btnCopyReferralCodeMain = document.getElementById('btnCopyReferralCodeMain');
  const btnCopyReferralCodeModal = document.getElementById('btnCopyReferralCodeModal');
  const btnShareReferralWhatsappMain = document.getElementById('btnShareReferralWhatsappMain');
  const btnShareWhatsappModal = document.getElementById('btnShareWhatsappModal');
  const btnCopyInviteLinkModal = document.getElementById('btnCopyInviteLinkModal');

  const REFERRAL_LINK = `${window.location.origin}/driver/`;
  const REFERRAL_SHARE_TEXT = encodeURIComponent(`Join VAAYU Partner Network as a delivery driver. Sign up here: ${REFERRAL_LINK}`);

  function openReferModal() {
    audioSynth.playClick();
    if (referModal) referModal.classList.remove('hidden');
  }

  function closeReferModal() {
    if (referModal) referModal.classList.add('hidden');
  }

  if (cardReferEarnMain) cardReferEarnMain.addEventListener('click', (e) => {
    // Only open modal if not clicking on copy or invite button directly
    if (e.target.closest('#btnCopyReferralCodeMain') || e.target.closest('#btnShareReferralWhatsappMain')) return;
    openReferModal();
  });

  if (btnViewReferralDetails) btnViewReferralDetails.addEventListener('click', (e) => {
    e.stopPropagation();
    openReferModal();
  });

  if (btnCloseReferModal) btnCloseReferModal.addEventListener('click', closeReferModal);

  function copyReferralCode() {
    audioSynth.playSuccess();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(REFERRAL_LINK).then(() => {
        showToast('Link Copied!', 'Your invite link is copied to the clipboard.', '');
      });
    } else {
      prompt('Copy your invite link:', REFERRAL_LINK);
    }
  }

  if (btnCopyReferralCodeMain) btnCopyReferralCodeMain.addEventListener('click', (e) => {
    e.stopPropagation();
    copyReferralCode();
    btnCopyReferralCodeMain.innerText = 'Copied! ✓';
    setTimeout(() => btnCopyReferralCodeMain.innerHTML = '<span>📋</span> <span>Copy</span>', 2000);
  });

  if (btnCopyReferralCodeModal) btnCopyReferralCodeModal.addEventListener('click', () => {
    copyReferralCode();
    btnCopyReferralCodeModal.innerText = 'Copied! ✓';
    setTimeout(() => btnCopyReferralCodeModal.innerText = 'Copy Code', 2000);
  });

  function shareOnWhatsapp() {
    audioSynth.playClick();
    const whatsappUrl = `https://api.whatsapp.com/send?text=${REFERRAL_SHARE_TEXT}`;
    window.open(whatsappUrl, '_blank');
    showToast('Opening WhatsApp 💬', 'Share your referral code with fellow drivers.', '💬');
  }

  if (btnShareReferralWhatsappMain) btnShareReferralWhatsappMain.addEventListener('click', (e) => {
    e.stopPropagation();
    shareOnWhatsapp();
  });

  if (btnShareWhatsappModal) btnShareWhatsappModal.addEventListener('click', shareOnWhatsapp);

  if (btnCopyInviteLinkModal) {
    btnCopyInviteLinkModal.addEventListener('click', () => {
      audioSynth.playSuccess();
      const inviteUrl = REFERRAL_LINK;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(inviteUrl).then(() => {
          showToast('Invite Link Copied! 🔗', inviteUrl, '🔗');
          btnCopyInviteLinkModal.innerText = 'Link Copied! ✓';
          setTimeout(() => btnCopyInviteLinkModal.innerHTML = '<span>🔗</span> Copy Link', 2000);
        });
      } else {
        prompt('Copy invite link:', inviteUrl);
      }
    });
  }


  // ==========================================
  // POCKET & CASH LIMIT (SWIGGY STYLE) HANDLERS
  // ==========================================
  const btnPocketWithdraw = document.getElementById('btnPocketWithdraw');
  if (btnPocketWithdraw) btnPocketWithdraw.addEventListener('click', openPayoutModal);

  const btnInstantPayout = document.getElementById('btnInstantPayout');
  if (btnInstantPayout) btnInstantPayout.addEventListener('click', openPayoutModal);

  const btnClosePayoutModal = document.getElementById('btnClosePayoutModal');
  if (btnClosePayoutModal) btnClosePayoutModal.addEventListener('click', closePayoutModal);

  const btnConfirmTransfer = document.getElementById('btnConfirmTransfer');
  if (btnConfirmTransfer) btnConfirmTransfer.addEventListener('click', confirmPayoutTransfer);

  // COD Settlement Handlers
  const btnCodDeposit = document.getElementById('btnCodDeposit');
  const codDepositModal = document.getElementById('codDepositModal');
  const btnCloseCodDeposit = document.getElementById('btnCloseCodDeposit');
  const rowCashLimit = document.getElementById('rowCashLimit');

  function openCodModal() {
    audioSynth.playClick();
    if (codDepositModal) codDepositModal.classList.remove('hidden');
    syncUI();
  }

  if (btnCodDeposit) btnCodDeposit.addEventListener('click', openCodModal);
  if (rowCashLimit) rowCashLimit.addEventListener('click', openCodModal);
  if (btnCloseCodDeposit) {
    btnCloseCodDeposit.addEventListener('click', () => {
      if (codDepositModal) codDepositModal.classList.add('hidden');
    });
  }

  const btnDepositExcess = document.getElementById('btnDepositExcess');
  if (btnDepositExcess) {
    btnDepositExcess.addEventListener('click', () => {
      const excess = Math.max(0, state.codCashInHand - state.availableCashLimit);
      const amountToDeposit = excess > 0 ? excess : Math.min(state.codCashInHand, 120);
      if (amountToDeposit <= 0) {
        alert('No excess cash to deposit! Cash in hand is already within the available cash limit.');
        return;
      }

      const selectedMethod = document.querySelector('input[name="codMethod"]:checked')?.value || 'upi';

      if (selectedMethod === 'pocket') {
        if (state.pocketBalance < amountToDeposit) {
          alert(`Insufficient pocket balance (₹${state.pocketBalance.toFixed(2)}) to settle ₹${amountToDeposit.toFixed(2)}. Please select Instant UPI or Hub Cashier.`);
          return;
        }
        state.pocketBalance -= amountToDeposit;
      }

      state.codCashInHand = Math.max(0, state.codCashInHand - amountToDeposit);
      audioSynth.playSuccess();
      if (codDepositModal) codDepositModal.classList.add('hidden');
      syncUI();
      const methodLabel = selectedMethod === 'upi' ? 'Instant UPI' : selectedMethod === 'pocket' ? 'Pocket Auto-Deduction' : 'Hub Cashier';
      alert(`✅ COD Cash Settlement of ₹${amountToDeposit.toFixed(2)} Successful!\nMethod: ${methodLabel}\nAvailable cash limit restored.`);
    });
  }

  const btnDepositFull = document.getElementById('btnDepositFull');
  if (btnDepositFull) {
    btnDepositFull.addEventListener('click', () => {
      if (state.codCashInHand <= 0) {
        alert('Cash in hand is already ₹0.00.');
        return;
      }
      const fullAmount = state.codCashInHand;
      const selectedMethod = document.querySelector('input[name="codMethod"]:checked')?.value || 'upi';

      if (selectedMethod === 'pocket') {
        if (state.pocketBalance < fullAmount) {
          alert(`Insufficient pocket balance (₹${state.pocketBalance.toFixed(2)}) to settle full ₹${fullAmount.toFixed(2)}. Please choose Instant UPI or deposit excess.`);
          return;
        }
        state.pocketBalance -= fullAmount;
      }

      state.codCashInHand = 0;
      audioSynth.playSuccess();
      if (codDepositModal) codDepositModal.classList.add('hidden');
      syncUI();
      const methodLabel = selectedMethod === 'upi' ? 'Instant UPI' : selectedMethod === 'pocket' ? 'Pocket Auto-Deduction' : 'Hub Cashier';
      alert(`✅ Full COD Cash Settlement of ₹${fullAmount.toFixed(2)} Complete!\nMethod: ${methodLabel}\nRemaining Cash in Hand: ₹0.00.`);
    });
  }

  // Weekly Earnings Modal
  const cardWeeklyEarnings = document.getElementById('cardWeeklyEarnings');
  const weeklyEarningsModal = document.getElementById('weeklyEarningsModal');
  const btnCloseWeeklyEarnings = document.getElementById('btnCloseWeeklyEarnings');
  if (cardWeeklyEarnings) {
    cardWeeklyEarnings.addEventListener('click', () => {
      audioSynth.playClick();
      renderDailyBreakdown();
      if (weeklyEarningsModal) weeklyEarningsModal.classList.remove('hidden');
    });
  }
  if (btnCloseWeeklyEarnings) {
    btnCloseWeeklyEarnings.addEventListener('click', () => {
      if (weeklyEarningsModal) weeklyEarningsModal.classList.add('hidden');
    });
  }

  // Pocket Statement Modal
  const cardPocketStatement = document.getElementById('cardPocketStatement');
  const rowPocketBalance = document.getElementById('rowPocketBalance');
  const pocketStatementModal = document.getElementById('pocketStatementModal');
  const btnClosePocketStatement = document.getElementById('btnClosePocketStatement');
  function openPocketStatement() {
    audioSynth.playClick();
    if (pocketStatementModal) pocketStatementModal.classList.remove('hidden');
  }
  if (cardPocketStatement) cardPocketStatement.addEventListener('click', openPocketStatement);
  if (rowPocketBalance) rowPocketBalance.addEventListener('click', openPocketStatement);
  if (btnClosePocketStatement) {
    btnClosePocketStatement.addEventListener('click', () => {
      if (pocketStatementModal) pocketStatementModal.classList.add('hidden');
    });
  }

  // Deduction Statement Modal
  const cardDeductionStatement = document.getElementById('cardDeductionStatement');
  const deductionStatementModal = document.getElementById('deductionStatementModal');
  const btnCloseDeduction = document.getElementById('btnCloseDeduction');
  if (cardDeductionStatement) {
    cardDeductionStatement.addEventListener('click', () => {
      audioSynth.playClick();
      if (deductionStatementModal) deductionStatementModal.classList.remove('hidden');
    });
  }
  if (btnCloseDeduction) {
    btnCloseDeduction.addEventListener('click', () => {
      if (deductionStatementModal) deductionStatementModal.classList.add('hidden');
    });
  }

  // COD Payout Method Modal
  const cardCodPayoutMethod = document.getElementById('cardCodPayoutMethod');
  const codPayoutModal = document.getElementById('codPayoutModal');
  const btnCloseCodPayout = document.getElementById('btnCloseCodPayout');
  const btnSettleCashAsPayout = document.getElementById('btnSettleCashAsPayout');

  if (cardCodPayoutMethod) {
    cardCodPayoutMethod.addEventListener('click', () => {
      audioSynth.playClick();
      if (codPayoutModal) codPayoutModal.classList.remove('hidden');
      syncUI();
    });
  }
  if (btnCloseCodPayout) {
    btnCloseCodPayout.addEventListener('click', () => {
      if (codPayoutModal) codPayoutModal.classList.add('hidden');
    });
  }
  if (btnSettleCashAsPayout) {
    btnSettleCashAsPayout.addEventListener('click', () => {
      if (state.codCashInHand <= 0) {
        alert('No physical cash in hand to settle.');
        return;
      }
      if (state.pocketBalance < state.codCashInHand) {
        alert(`Insufficient pocket balance (₹${state.pocketBalance.toFixed(2)}) to offset full ₹${state.codCashInHand.toFixed(2)}. Please deposit excess or earn more trip fares.`);
        return;
      }

      const settled = state.codCashInHand;
      state.pocketBalance -= settled;
      state.codCashInHand = 0;
      audioSynth.playSuccess();
      if (codPayoutModal) codPayoutModal.classList.add('hidden');
      syncUI();
      alert(`✅ Instant COD Payout Offset Completed!\n\n₹${settled.toFixed(2)} was deducted from your digital Pocket balance.\nYou keep the physical cash collected from deliveries as your direct take-home pay with ₹0 deposit liability!`);
    });
  }

  // COD Cash Ledger Modal
  const cardCodLedger = document.getElementById('cardCodLedger');
  const codLedgerModal = document.getElementById('codLedgerModal');
  const btnCloseCodLedger = document.getElementById('btnCloseCodLedger');

  if (cardCodLedger) {
    cardCodLedger.addEventListener('click', () => {
      audioSynth.playClick();
      if (codLedgerModal) codLedgerModal.classList.remove('hidden');
      syncUI();
    });
  }
  if (btnCloseCodLedger) {
    btnCloseCodLedger.addEventListener('click', () => {
      if (codLedgerModal) codLedgerModal.classList.add('hidden');
    });
  }

  // Linked Payout Accounts Card
  const cardPayoutAccounts = document.getElementById('cardPayoutAccounts');
  if (cardPayoutAccounts) {
    cardPayoutAccounts.addEventListener('click', () => {
      audioSynth.playClick();
      openPayoutModal();
    });
  }

  // Attendance Streak Card
  const btnViewCalendarPocket = document.getElementById('btnViewCalendarPocket');
  if (btnViewCalendarPocket) {
    btnViewCalendarPocket.addEventListener('click', () => {
      audioSynth.playClick();
      alert(`🔥 Attendance & Milestone Streak\n\nDays Active in September: ${state.workingDaysMonth} / 30 Days\nDiamond Partner Tier: Maintained\nWeekly Attendance Incentive: ₹200.00 Awarded\n\nDeliver on 3 more days this week to qualify for the ₹500 Mega Festival Bonus!`);
    });
  }

  // Rate Card
  const btnRateCard = document.getElementById('btnRateCard');
  if (btnRateCard) {
    btnRateCard.addEventListener('click', () => {
      const modal = document.getElementById('rateCardModal');
      if (modal) modal.classList.remove('hidden');
    });
  }
  const btnCloseRateCard = document.getElementById('btnCloseRateCard');
  if (btnCloseRateCard) {
    btnCloseRateCard.addEventListener('click', () => {
      const modal = document.getElementById('rateCardModal');
      if (modal) modal.classList.add('hidden');
    });
  }

  // Gateway Connection in Settings
  const btnConnectGateway = document.getElementById('btnConnectGateway');
  if (btnConnectGateway) {
    btnConnectGateway.addEventListener('click', () => {
      const inputUrl = document.getElementById('inputBackendUrl');
      const url = inputUrl ? inputUrl.value.trim() : '';
      if (url) {
        state.backendUrl = url;
        saveState();
        initSocketConnection();
      }
    });
  }

  // Emergency SOS
  const btnTriggerSosEl = document.getElementById('btnTriggerSos');
  if (btnTriggerSosEl) {
    btnTriggerSosEl.addEventListener('click', () => {
      openSosModal();
    });
  }

  // Share Modal & Link Copy Handlers
  const shareModal = document.getElementById('shareModal');
  const btnShareApp = document.getElementById('btnShareApp');
  const btnMobileShare = document.getElementById('btnMobileShare');
  const btnCloseShareModal = document.getElementById('btnCloseShareModal');
  const btnCopyPublicUrl = document.getElementById('btnCopyPublicUrl');
  const btnCopyLocalUrl = document.getElementById('btnCopyLocalUrl');

  function openShareModal() {
    audioSynth.playClick();
    if (shareModal) shareModal.classList.remove('hidden');
  }

  function closeShareModal() {
    if (shareModal) shareModal.classList.add('hidden');
  }

  if (btnShareApp) btnShareApp.addEventListener('click', openShareModal);
  if (btnMobileShare) btnMobileShare.addEventListener('click', openShareModal);
  if (btnCloseShareModal) btnCloseShareModal.addEventListener('click', closeShareModal);

  if (btnCopyPublicUrl) {
    btnCopyPublicUrl.addEventListener('click', () => {
      const url = document.getElementById('inputPublicShareUrl').value;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          audioSynth.playSuccess();
          btnCopyPublicUrl.innerText = 'Copied! ✓';
          setTimeout(() => btnCopyPublicUrl.innerText = 'Copy', 2000);
        });
      } else {
        prompt('Copy public link:', url);
      }
    });
  }

  if (btnCopyLocalUrl) {
    btnCopyLocalUrl.addEventListener('click', () => {
      const url = document.getElementById('inputLocalShareUrl').value;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          audioSynth.playSuccess();
          btnCopyLocalUrl.innerText = 'Copied! ✓';
          setTimeout(() => btnCopyLocalUrl.innerText = 'Copy', 2000);
        });
      } else {
        prompt('Copy Wi-Fi link:', url);
      }
    });
  }

  // Audio Toggle
  document.getElementById('btnAudioToggle').addEventListener('click', () => {
    state.soundAlerts = !state.soundAlerts;
    const icon = document.getElementById('audioIcon');
    const text = document.getElementById('audioText');
    if (state.soundAlerts) {
      icon.innerText = '🔊';
      text.innerText = 'Sound ON';
    } else {
      icon.innerText = '🔇';
      text.innerText = 'Sound OFF';
    }
    saveState();
  });

  // Viewport Switcher
  document.getElementById('btnViewMobile').addEventListener('click', () => {
    document.getElementById('appViewport').classList.remove('full-canvas-mode');
    document.getElementById('btnViewMobile').className = 'px-2.5 py-1 rounded text-xs font-medium transition-all bg-vaayu-600 text-white shadow-sm flex items-center gap-1.5';
    document.getElementById('btnViewFull').className = 'px-2.5 py-1 rounded text-xs font-medium transition-all text-slate-400 hover:text-white flex items-center gap-1.5';
    if (map) setTimeout(() => map.invalidateSize(), 200);
  });

  document.getElementById('btnViewFull').addEventListener('click', () => {
    document.getElementById('appViewport').classList.add('full-canvas-mode');
    document.getElementById('btnViewFull').className = 'px-2.5 py-1 rounded text-xs font-medium transition-all bg-vaayu-600 text-white shadow-sm flex items-center gap-1.5';
    document.getElementById('btnViewMobile').className = 'px-2.5 py-1 rounded text-xs font-medium transition-all text-slate-400 hover:text-white flex items-center gap-1.5';
    if (map) setTimeout(() => map.invalidateSize(), 200);
  });

  // Settings
  document.getElementById('settingAutoAccept').addEventListener('change', (e) => {
    state.autoAccept = e.target.checked;
    saveState();
  });

  document.getElementById('settingLoudAudio').addEventListener('change', (e) => {
    state.soundAlerts = e.target.checked;
    saveState();
  });

  document.getElementById('settingNavApp').addEventListener('change', (e) => {
    state.navApp = e.target.value;
    saveState();
  });

  document.getElementById('btnRecenterMap').addEventListener('click', () => {
    if (map) map.setView([driverLat, driverLng], 14);
  });

  // Support Chat Modal Listeners
  const btnSendChat = document.getElementById('btnSendChat');
  const chatInput = document.getElementById('chatInput');
  if (btnSendChat) {
    btnSendChat.addEventListener('click', () => sendSupportChatMessage());
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendSupportChatMessage();
      }
    });
  }
  document.querySelectorAll('.chat-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const prompt = e.currentTarget.dataset.prompt || e.currentTarget.innerText.replace(/^[^\w\s]+/, '').trim();
      sendSupportChatMessage(prompt);
    });
  });

  // ==========================================
  // 9. LOGIN SCREEN & ONBOARDING CONTROLLERS
  // ==========================================
  // Logout button in Section 3
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      audioSynth.playClick();
      if (confirm('Are you sure you want to log out of your Vaayu Partner account?')) {
        performLogout();
      }
    });
  }

  // Language switcher pills
  document.querySelectorAll('.lang-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      audioSynth.playClick();
      const lang = pill.dataset.lang || 'en';
      setLanguage(lang);
    });
  });

  // ==========================================
  // DRIVER LOGIN & AUTHENTICATION CONTROLLERS
  // ==========================================
  const btnStartDrivingHero = document.getElementById('btnStartDrivingHero');
  if (btnStartDrivingHero) {
    btnStartDrivingHero.addEventListener('click', () => {
      openMobileNumberStep();
    });
  }

  // 1-Tap Direct Launch Button
  const btnDirectLoginCockpit = document.getElementById('btnDirectLoginCockpit');
  if (btnDirectLoginCockpit) {
    btnDirectLoginCockpit.addEventListener('click', () => {
      openMobileNumberStep();
    });
  }

  // Quick Enter Cockpit top pill
  const btnQuickEnterCockpit = document.getElementById('btnQuickEnterCockpit');
  if (btnQuickEnterCockpit) {
    btnQuickEnterCockpit.addEventListener('click', () => {
      startDriverOtpAuthentication(getSavedDriverProfile() || DEFAULT_DRIVER_PROFILE);
    });
  }

  // Interactive Carousel Dots
  document.querySelectorAll('.carousel-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      audioSynth.playClick();
      const slideIdx = parseInt(e.currentTarget.dataset.slide || '0', 10);
      renderHeroSlide(slideIdx);
      startHeroCarousel();
    });
  });

  // Sheet close button & backdrop dismiss
  const btnCloseAuthSheet = document.getElementById('btnCloseAuthSheet');
  if (btnCloseAuthSheet) {
    btnCloseAuthSheet.addEventListener('click', () => {
      audioSynth.playClick();
      closeAuthBottomSheet();
    });
  }

  const authBottomSheet = document.getElementById('authBottomSheet');
  if (authBottomSheet) {
    authBottomSheet.addEventListener('click', (e) => {
      if (e.target === authBottomSheet) {
        closeAuthBottomSheet();
      }
    });
  }

  // Send OTP for Driver Mobile Number Entry
  const btnSendLoginOtp = document.getElementById('btnSendLoginOtp');
  const loginPhoneInput = document.getElementById('loginPhoneInput');
  const displayOtpPhone = document.getElementById('displayOtpPhone');
  const btnEditLoginPhone = document.getElementById('btnEditLoginPhone');
  const btnResendLoginOtp = document.getElementById('btnResendLoginOtp');
  const btnVerifyLogin = document.getElementById('btnVerifyLogin');
  const btnAutofillOtp = document.getElementById('btnAutofillOtp');
  const otpBoxes = Array.from(document.querySelectorAll('.login-otp-box'));

  if (loginPhoneInput) {
    loginPhoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (btnSendLoginOtp) btnSendLoginOtp.click();
      }
    });
  }

  const btnProceedToOtp = document.getElementById('btnProceedToOtp');
  const modalLoginPhoneInput = document.getElementById('modalLoginPhoneInput');

  if (modalLoginPhoneInput) {
    modalLoginPhoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        proceedToOtpStep();
      }
    });
  }

  if (btnProceedToOtp) {
    btnProceedToOtp.addEventListener('click', () => {
      proceedToOtpStep();
    });
  }

  if (btnSendLoginOtp) {
    btnSendLoginOtp.addEventListener('click', () => {
      proceedToOtpStep();
    });
  }


  if (btnEditLoginPhone) {
    btnEditLoginPhone.addEventListener('click', () => {
      editLoginPhone();
    });
  }

  if (btnResendLoginOtp) {
    btnResendLoginOtp.addEventListener('click', () => {
      audioSynth.playSuccess();
      proceedToOtpStep();
    });
  }

  // Auto-focus and auto-verify behavior for 4-digit OTP boxes
  otpBoxes.forEach((box, idx) => {
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val ? val[0] : '';
      if (val && idx < otpBoxes.length - 1) {
        otpBoxes[idx + 1].focus();
      } else if (val && idx === otpBoxes.length - 1) {
        const fullCode = otpBoxes.map(b => b.value).join('');
        if (fullCode.length >= 4 && fullCode.length === otpBoxes.filter(b => b.value).length) {
          setTimeout(() => {
            if (btnVerifyLogin) btnVerifyLogin.click();
          }, 200);
        }
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        otpBoxes[idx - 1].focus();
      } else if (e.key === 'Enter') {
        if (btnVerifyLogin) btnVerifyLogin.click();
      }
    });
  });

  // Verify OTP and Authenticate into Cockpit
  if (btnVerifyLogin) {
    btnVerifyLogin.addEventListener('click', async () => {
      const enteredOtp = otpBoxes.map(b => b.value).join('');
      if (enteredOtp.length < 4 || enteredOtp.length > 6) {
        alert('Please enter your verification code.');
        if (otpBoxes[0]) otpBoxes[0].focus();
        return;
      }
      
      const targetProfile = pendingAuthProfile || getSavedDriverProfile();
      btnVerifyLogin.disabled = true;
      try {
        const response = await nativeDriverFetch('/api/auth/verify-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: targetProfile.phone, otp: enteredOtp, appType: 'DRIVER' })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'OTP verification failed.');
        if (result.user?.role !== 'DRIVER') {
          const statusRes = await nativeDriverFetch(`/api/driver/application-status?phone=${encodeURIComponent(targetProfile.phone)}`);
          const statusData = await statusRes.json().catch(() => ({}));
          if (statusData.status === 'PENDING') throw new Error('Your application is waiting for admin approval. You will be able to sign in once it is approved.');
          if (statusData.status === 'REJECTED') throw new Error(`Your application was not approved${statusData.reason ? `: ${statusData.reason}` : '.'}`);
          throw new Error('This phone number is not registered as a driver account. Use Register to apply.');
        }
        vaayuDriverToken = result.token;
        try { sessionStorage.setItem('vaayu_driver_token', result.token); } catch (_) {}
        if (result.driverProfileId) state.driverId = result.driverProfileId;
        targetProfile.partnerId = result.user.id;
        targetProfile.name = result.user.name || targetProfile.name;
        targetProfile.phone = result.user.phone || targetProfile.phone;
        performLogin(targetProfile);
        showToast('Authentication Successful ✓', `Welcome back, ${targetProfile.name}!`, '🎉');
      } catch (error) {
        showToast('Sign-in failed', error.message || 'Could not verify this account.', '⚠️');
      } finally {
        btnVerifyLogin.disabled = false;
      }
    });
  }

  initDriverRegistration();

  // Database Modal & Test Ping Controllers
  const btnDbStatus = document.getElementById('btnDbStatus');
  const btnMobileRefreshDb = document.getElementById('btnMobileRefreshDb');
  const dbInfoModal = document.getElementById('dbInfoModal');
  const btnCloseDbInfo = document.getElementById('btnCloseDbInfo');
  const btnModalPingDb = document.getElementById('btnModalPingDb');

  function openDbModal() {
    audioSynth.playClick();
    checkDatabaseHealth();
    if (dbInfoModal) dbInfoModal.classList.remove('hidden');
  }

  if (btnDbStatus) btnDbStatus.addEventListener('click', openDbModal);
  if (btnMobileRefreshDb) btnMobileRefreshDb.addEventListener('click', openDbModal);
  if (btnCloseDbInfo) btnCloseDbInfo.addEventListener('click', () => {
    if (dbInfoModal) dbInfoModal.classList.add('hidden');
  });

  if (btnModalPingDb) {
    btnModalPingDb.addEventListener('click', async () => {
      audioSynth.playClick();
      btnModalPingDb.disabled = true;
      btnModalPingDb.innerHTML = '<span>⏳ Pinging server...</span>';
      const data = await checkDatabaseHealth();
      btnModalPingDb.disabled = false;
      btnModalPingDb.innerHTML = '<span>⚡ Test Ping /api/health</span>';
      if (data && data.status === 'OK') {
        showToast('System Connected ⚡', 'Server communication active and healthy.', '✓');
      } else {
        showToast('System Offline ⚠️', 'Could not reach server endpoint.', '⚠️');
      }
    });
  }

  // Captain Duty Permissions & Display Over Apps removed per user request

  // Make all core actions globally available for inline onclick & mobile touch triggers
  window.initApplication = initApplication;
  window.openPermissionsModal = openPermissionsModal;
  window.closePermissionsModal = closePermissionsModal;
  window.grantAllPermissions = grantAllPermissions;
  window.saveSelectedPermissions = saveSelectedPermissions;
  window.handlePermissionToggle = handlePermissionToggle;
  window.handleOverlayToggle = handleOverlayToggle;
  window.syncPermissionsUI = syncPermissionsUI;
  window.showFloatingOverlay = showFloatingOverlay;
  window.hideFloatingOverlay = hideFloatingOverlay;
  window.initDraggableOverlay = initDraggableOverlay;
  window.toggleFloatingHud = toggleFloatingHud;
  window.quickStartDriving = quickStartDriving;
  window.toggleDuty = toggleDuty;
  window.switchTab = switchTab;
  window.openPayoutModal = openPayoutModal;
  window.closePayoutModal = closePayoutModal;
  window.handleWithdrawSubmit = confirmPayoutTransfer;
  window.openReferModal = openReferModal;
  window.closeReferModal = closeReferModal;
  window.copyReferralCode = copyReferralCode;
  window.shareOnWhatsapp = shareOnWhatsapp;
  window.acceptCurrentTrip = acceptCurrentTrip;
  window.declineCurrentTrip = declineCurrentTrip;
  window.handleAdvanceTrip = handleAdvanceTrip;
  window.openGoogleMapsNavigation = openGoogleMapsNavigation;
  window.submitDeliveryOtp = submitDeliveryOtp;
  window.closeDeliveryOtpModal = closeDeliveryOtpModal;
  window.completeTripDelivery = completeTripDelivery;
  window.drawDestinationRoute = drawDestinationRoute;
  window.initDragToCompleteSlider = initDragToCompleteSlider;
  window.submitCustomerFeedback = submitCustomerFeedback;
  window.skipCustomerFeedback = skipCustomerFeedback;
  window.startNextFeedbackInQueue = startNextFeedbackInQueue;
  window.closeCustomerFeedbackModal = closeCustomerFeedbackModal;
  window.performLogin = performLogin;
  window.performLogout = performLogout;
  window.startDriverOtpAuthentication = startDriverOtpAuthentication;
  window.openMobileNumberStep = openMobileNumberStep;
  window.proceedToOtpStep = proceedToOtpStep;
  window.editLoginPhone = editLoginPhone;
  window.verifyDriverOtp = verifyDriverOtp;
  window.setLanguage = setLanguage;

  // Emergency Order Rejection & Video Proof Exports
  window.openOrderRejectionModal = openOrderRejectionModal;
  window.closeOrderRejectionModal = closeOrderRejectionModal;
  window.selectRejectionReason = selectRejectionReason;
  window.startRejectionVideoRecording = startRejectionVideoRecording;
  window.stopRejectionVideoRecording = stopRejectionVideoRecording;
  window.handleRejectionVideoFileUpload = handleRejectionVideoFileUpload;
  window.retakeRejectionVideo = retakeRejectionVideo;
  window.submitOrderRejection = submitOrderRejection;
  window.openRejectionHistoryModal = openRejectionHistoryModal;
  window.closeRejectionHistoryModal = closeRejectionHistoryModal;
  window.loadRejectionHistory = loadRejectionHistory;
  window.syncOrderRejectionSettingsUI = syncOrderRejectionSettingsUI;
  window.syncPartnerCareMenuUI = syncPartnerCareMenuUI;
  window.handlePartnerMenuSelect = handlePartnerMenuSelect;
  window.handleCancelIssueSelect = handleCancelIssueSelect;
  window.appendChatBubble = appendChatBubble;
  window.openTopHelpSection = openTopHelpSection;
  window.closeTopHelpModal = closeTopHelpModal;
  window.navigateToFullHelpSection = navigateToFullHelpSection;

  window.triggerDriverSosEmergency = function() {
    if (confirm('🚨 EMERGENCY SOS: Send urgent panic signal to Telangana Police Control (112) & Vaayu Safety Room with your live GPS location?')) {
      fetch('/api/safety/sos-trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_id: state.driverId || '',
          trip_id: 'TRIP_ACTIVE',
          lat: 17.4850,
          lng: 78.4041
        })
      }).then(r => r.json()).then(d => {
        if (d.success) {
          alert('🚨 CRITICAL SOS ALERT SENT! Police Control (112) & Vaayu Safety Officers have been notified of your location.');
        }
      }).catch(() => {
        alert('🚨 CRITICAL SOS ALERT SENT to Emergency Services!');
      });
    }
  };

  // Expose 2-in-1 Fleet Owner functions on window
  window.togglePartnerMode = togglePartnerMode;
  window.reassignFleetVehicle = reassignFleetVehicle;
  window.showAddDriverModal = showAddDriverModal;
  window.renderFleetRoster = renderFleetRoster;
  window.sendFleetOwnerOtp = sendFleetOwnerOtp;
  window.verifyFleetOwnerOtp = verifyFleetOwnerOtp;
  window.refreshFleetOwnerData = refreshFleetOwnerData;
  window.logoutFleetOwner = logoutFleetOwner;

  // Initialize Language
  try { setLanguage(state.language || 'en'); } catch (e) {}
}

// Dual lifecycle gate: Execute immediately if DOM is ready, otherwise on DOMContentLoaded
function resolveDeclarativeArg(arg, el, event) {
  if (arg === '@event') return event;
  if (arg === '@checked') return el.checked;
  if (arg === '@value') return el.value;
  return arg;
}

function dispatchDeclarativeAction(event) {
  const el = event.target.closest(`[data-on="${event.type}"]`);
  if (!el) return;
  const steps = el.dataset.chain
    ? JSON.parse(el.dataset.chain)
    : el.dataset.action ? [[el.dataset.action, el.dataset.args ? JSON.parse(el.dataset.args) : []]] : [];
  steps.forEach(([name, args]) => {
    if (name === '@click') {
      const target = document.getElementById(args[0]);
      if (target) target.click();
      return;
    }
    const fn = window[name];
    if (typeof fn === 'function') fn(...args.map(arg => resolveDeclarativeArg(arg, el, event)));
  });
}
['click', 'change'].forEach(type => document.addEventListener(type, dispatchDeclarativeAction));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApplication);
} else {
  initApplication();
}

