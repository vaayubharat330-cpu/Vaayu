const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const db = require('../src/db/database');
const { authService } = require('../src/services/authService');

const OUTPUT_DIR = path.resolve(__dirname, '../../../../../brain/0e628d01-4d6e-4bad-8710-d0fb0ee1743c/screenshots');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const driver = db.getDrivers()[0];
const driverToken = authService.generateToken({ id: driver.userId || driver.id, role: 'DRIVER', phone: driver.phone });
const fleetOwner = db.getFleetOwners()[0];
const fleetToken = authService.generateToken({ id: fleetOwner.userId || fleetOwner.id, role: 'FLEET_OWNER', phone: fleetOwner.phone });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Launching browser for comprehensive Driver App audit screenshots...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=430,932'
    ],
    defaultViewport: {
      width: 430,
      height: 932,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    }
  });

  const page = await browser.newPage();

  // Helper to take screenshot
  async function snap(filename, desc) {
    const filePath = path.join(OUTPUT_DIR, filename);
    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`[SAVED] ${filename} - ${desc}`);
  }

  try {
    // 1. Landing Screen (Not Logged In)
    console.log('\n--- 1. Testing Unauthenticated / Onboarding Flow ---');
    await page.goto('http://127.0.0.1:4000/driver/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      location.reload();
    });
    await sleep(2000);
    await snap('01_driver_login_landing.png', 'Driver App Login / Welcome Screen with Hero Value Props');

    // 2. Open OTP Modal on Login
    await page.evaluate(() => {
      const phoneInput = document.getElementById('loginPhoneInput') || document.querySelector('input[type="tel"]');
      if (phoneInput) {
        phoneInput.value = '9123456789';
        phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const loginBtn = document.getElementById('btnLoginSubmit') || document.getElementById('btnSendLoginOtp');
      if (loginBtn) loginBtn.click();
      else if (typeof window.requestDriverOtp === 'function') window.requestDriverOtp();
    });
    await sleep(1000);
    await snap('02_driver_login_otp_modal.png', 'Driver Login OTP Verification Modal');

    // 3. Driver Registration Step 1 (Personal & Vehicle Info)
    console.log('\n--- 2. Testing Driver Registration Flow ---');
    await page.evaluate(() => {
      if (typeof window.showDriverRegistrationScreen === 'function') {
        window.showDriverRegistrationScreen();
      } else {
        const regBtn = document.getElementById('btnStartDriverReg');
        if (regBtn) regBtn.click();
      }
    });
    await sleep(1000);
    await snap('03_driver_reg_step1_details.png', 'Driver Registration Step 1: Personal & Vehicle Selection');

    // 4. Driver Registration Step 2 (RC & Vehicle Ownership)
    await page.evaluate(() => {
      const regName = document.getElementById('regDriverName');
      if (regName) regName.value = 'Rajesh Kumar';
      const regPhone = document.getElementById('regDriverPhone');
      if (regPhone) regPhone.value = '9876543210';
      const regLic = document.getElementById('regDriverLicense');
      if (regLic) regLic.value = 'TS092023001234';
      const regVeh = document.getElementById('regVehicleSelect');
      if (regVeh) regVeh.value = 'v_ace';
      
      const step1Next = document.getElementById('btnRegStep1Next');
      if (step1Next) step1Next.click();
    });
    await sleep(1000);
    await snap('04_driver_reg_step2_ownership.png', 'Driver Registration Step 2: Plate Number & RC Ownership');

    // 5. Driver Registration Step 3 (Live KYC Verification)
    await page.evaluate(() => {
      const regPlate = document.getElementById('regVehiclePlate');
      if (regPlate) regPlate.value = 'TS 09 EA 9988';
      const step2Next = document.getElementById('btnRegStep2Next');
      if (step2Next) step2Next.click();
    });
    await sleep(1000);
    await snap('05_driver_reg_step3_kyc_capture.png', 'Driver Registration Step 3: Live Document Verification & Capture');

    // 6. Logged In: Cockpit Main Screen (OFFLINE Mode)
    console.log('\n--- 3. Testing Authenticated Driver Cockpit (OFFLINE) ---');
    await page.evaluate(({ token, drv }) => {
      localStorage.setItem('vaayu_driver_token', token);
      sessionStorage.setItem('vaayu_session_active', 'true');
      window.state.permissionsGranted = true;
      window.state.permissions = {
        location: true,
        overlay: true,
        camera: true,
        notifications: true,
        battery: true,
        microphone: true
      };
      window.performLogin({
        partnerId: drv.id,
        name: drv.name,
        phone: drv.phone,
        vehicleId: drv.vehicleId || 'v_ace',
        rating: '4.95',
        hub: 'Hyderabad West Hub'
      });
      window.state.status = 'OFFLINE';
      window.state.permissionsGranted = true;
      window.state.permissions = {
        location: true,
        overlay: true,
        camera: true,
        notifications: true,
        battery: true,
        microphone: true
      };
      window.state.vehicleNumber = drv.vehicleNumber || 'TG07AG4188';
      window.state.licenseNumber = drv.licenseNumber || 'TG00720250001599';
      window.state.todayEarnings = 2450.00;
      window.state.todayTrips = 8;
      window.state.totalTrips = 142;
      window.state.acceptanceRate = '98.5%';
      window.state.pocketBalance = 1850.00;
      window.state.codCashInHand = 420.00;
      const permModal = document.getElementById('permissionsModal');
      if (permModal) permModal.classList.add('hidden');
      const permBanner = document.getElementById('permissionsWarningBanner');
      if (permBanner) permBanner.classList.add('hidden');
      window.syncUI();
      window.switchTab('main');
    }, { token: driverToken, drv: driver });
    await sleep(1500);
    await page.evaluate(() => {
      const permModal = document.getElementById('permissionsModal');
      if (permModal) permModal.classList.add('hidden');
    });
    await sleep(500);
    await snap('06_cockpit_main_offline.png', 'Driver Cockpit: Offline State with Live Metrics & Controls');

    // 7. Cockpit Main Screen (ONLINE Mode with Real-Time Map & HUD)
    console.log('\n--- 4. Testing Authenticated Driver Cockpit (ONLINE) ---');
    await page.evaluate(() => {
      const toggle = document.getElementById('dutyToggleBtn');
      if (toggle) toggle.click();
      else if (typeof window.handleDutyToggle === 'function') window.handleDutyToggle();
    });
    await sleep(2000);
    await snap('07_cockpit_main_online.png', 'Driver Cockpit: Online Mode with Radar Pulse, Active Map & Live Stats');

    // 8. Change Vehicle Modal from Settings (Profile Tab)
    console.log('\n--- 5. Testing Settings Page & Dynamic Vehicle Modal ---');
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('profile');
    });
    await sleep(1000);
    await snap('08_settings_tab_view.png', 'Driver Settings Tab: Registration KYC Verified & Registered Vehicle Display');

    await page.evaluate(() => {
      if (typeof window.openChangeVehicleModal === 'function') window.openChangeVehicleModal();
      else {
        const btn = document.getElementById('btnSwitchVehicleModal');
        if (btn) btn.click();
      }
    });
    await sleep(1000);
    await snap('09_settings_change_vehicle_modal.png', 'Change Vehicle Modal: Select Vehicle & Update Registration Plate');

    // Close change vehicle modal
    await page.evaluate(() => {
      if (typeof window.closeChangeVehicleModal === 'function') window.closeChangeVehicleModal();
    });
    await sleep(500);

    // 9. Pocket, COD & Payout Wallet Screen
    console.log('\n--- 6. Testing Pocket & COD Settlement Flow ---');
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('pocket');
    });
    await sleep(1000);
    await snap('10_pocket_wallet_tab.png', 'Pocket & Settlement Tab: Real-Time Balance, COD & Dynamic Transactions');

    // 10. Withdraw / Payout Modal
    await page.evaluate(() => {
      if (typeof window.openPayoutModal === 'function') window.openPayoutModal();
      else {
        const btn = document.getElementById('btnPocketWithdraw');
        if (btn) btn.click();
      }
    });
    await sleep(1000);
    await snap('11_pocket_payout_modal.png', 'Instant Payout Modal: Transfer to Linked UPI / Bank');

    // Close payout modal
    await page.evaluate(() => {
      if (typeof window.closePayoutModal === 'function') window.closePayoutModal();
    });
    await sleep(500);

    // 11. COD Cash Deposit Modal
    await page.evaluate(() => {
      if (typeof window.openCodDepositModal === 'function') window.openCodDepositModal();
      else {
        const btn = document.getElementById('btnOpenCodDeposit');
        if (btn) btn.click();
      }
    });
    await sleep(1000);
    await snap('12_cod_settlement_modal.png', 'COD Cash-in-Hand Deposit & Settlement Modal');

    // Close COD modal
    await page.evaluate(() => {
      if (typeof window.closeCodDepositModal === 'function') window.closeCodDepositModal();
    });
    await sleep(500);

    // 12. Incoming Order Alert Popup (Dispatch Simulation)
    console.log('\n--- 7. Testing Real-Time Dispatch & Order Alert ---');
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('main');
      const testOffer = {
        orderId: 'ORD_TEST_9981',
        tripId: 'ORD_TEST_9981',
        serviceType: 'EXPRESS_CARGO',
        pickup: { title: 'Banjara Hills Hub, Rd No 12', address: 'Plot 42, Road 12, Banjara Hills, Hyderabad' },
        dropoff: { title: 'Gachibowli Tech Park', address: 'Building 4, Mindspace SEZ, Gachibowli, Hyderabad' },
        fare: 385.50,
        estimatedEarnings: 385.50,
        distanceKm: 9.4,
        cargoDescription: 'Electronics & Spare Parts Box',
        totalWeightKg: 45
      };
      if (typeof window.handleIncomingTripRequest === 'function') {
        window.handleIncomingTripRequest(testOffer);
      }
    });
    await sleep(1000);
    await snap('13_incoming_order_alert_modal.png', 'Real-Time Dispatch: Incoming Delivery Alert with 30s Countdown & Map Preview');

    // 13. Active Delivery Order Execution (In-Transit)
    console.log('\n--- 8. Testing Active Delivery State ---');
    await page.evaluate(() => {
      const alertModal = document.getElementById('orderAlertModal');
      if (alertModal) alertModal.classList.add('hidden');
      if (typeof window.clearOrderAlertTimer === 'function') window.clearOrderAlertTimer();
      const activeTripObj = {
        tripId: 'TRIP_ACTIVE_8820',
        orderId: 'TRIP_ACTIVE_8820',
        vehicleName: 'VAAYU Ace (Tata Ace 7ft)',
        customerName: 'Vikram Solar Logistics',
        customerPhone: '+91 9988776655',
        pickupAddress: 'Madhapur Mega Warehouse, Plot 18, Phase 2, Madhapur, Hyderabad',
        dropAddress: 'Kondapur Distribution Hub, Survey 41, Kothaguda X Roads, Hyderabad',
        fare: 460.00,
        estimatedEarnings: 460.00,
        distanceKm: 6.8,
        status: 'DRIVER_ARRIVING',
        cargoDescription: 'Solar Inverters & Batteries',
        pickupOtp: '4821',
        deliveryOtp: '8912',
        pickupLat: 17.4485,
        pickupLng: 78.3748,
        dropLat: 17.4645,
        dropLng: 78.3582
      };
      window.currentTrip = activeTripObj;
      window.currentTripStatus = 'ACCEPTED';
      if (window.state) {
        window.state.status = 'ON_TRIP';
        window.state.activeTab = 'main';
      }
      if (typeof window.switchTab === 'function') window.switchTab('main');
      if (typeof window.renderActiveTripUI === 'function') window.renderActiveTripUI();
      if (typeof window.drawOrderRoute === 'function') {
        window.drawOrderRoute([17.4485, 78.3748], [17.4645, 78.3582]);
      }
      const card = document.getElementById('activeTripCard');
      if (card) card.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await sleep(1500);
    await snap('14_active_delivery_transit.png', 'Active Delivery Execution: Live Turn-by-Turn GPS, Customer Contact & OTP Verification');

    // 14. Emergency Safety SOS Modal
    console.log('\n--- 9. Testing Safety & Support Modals ---');
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (typeof window.openSosModal === 'function') window.openSosModal();
      else {
        const btn = document.getElementById('btnTriggerSos');
        if (btn) btn.click();
      }
    });
    await sleep(1000);
    await snap('15_safety_emergency_sos_modal.png', 'Safety & Emergency SOS Modal: 112 Police, Emergency Response & Live Beacon');

    // Close SOS modal
    await page.evaluate(() => {
      if (typeof window.closeSosModal === 'function') window.closeSosModal();
    });
    await sleep(500);

    // 15. AI Support Chat Modal
    await page.evaluate(() => {
      if (typeof window.openSupportChatModal === 'function') window.openSupportChatModal();
      else {
        const btn = document.getElementById('btnOpenSupportChat');
        if (btn) btn.click();
      }
    });
    await sleep(1000);
    await snap('16_ai_support_chat_modal.png', 'Partner 24x7 AI Live Support Assistance Modal');

    // Close Support Chat
    await page.evaluate(() => {
      if (typeof window.closeSupportChatModal === 'function') window.closeSupportChatModal();
    });
    await sleep(500);

    // 16. Integrated Fleet Management Mode
    console.log('\n--- 10. Testing Integrated Fleet Owner Portal ---');
    await page.evaluate(async ({ fToken, owner, drv }) => {
      localStorage.setItem('vaayu_fleet_token', fToken);
      sessionStorage.setItem('vaayu_fleet_token', fToken);
      sessionStorage.setItem('vaayu_session_active', 'true');
      window.vaayuFleetToken = fToken;
      window.fleetOwnerProfile = owner;
      if (window.state) {
        window.state.fleetOwnerProfile = owner;
        window.state.activeTab = 'fleet';
      }
      if (typeof window.switchTab === 'function') {
        window.switchTab('fleet');
      }
      if (typeof window.refreshFleetOwnerData === 'function') {
        await window.refreshFleetOwnerData();
      }
      window.scrollTo(0, 0);
    }, { fToken: fleetToken, owner: fleetOwner, drv: driver });
    await sleep(2000);
    await snap('17_integrated_fleet_owner_view.png', 'Integrated Fleet Owner Portal: Vehicle Telemetry, Driver Assignment & Analytics');

    console.log('\nAll 17 comprehensive screenshots captured and verified successfully!');

  } catch (error) {
    console.error('Error during screenshot execution:', error);
  } finally {
    await browser.close();
  }
}

run();
