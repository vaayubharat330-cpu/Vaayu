# VAAYU — Unified Logistics & Mobility Operating System

[![CI](https://github.com/vaayu-logistics/vaayu/actions/workflows/ci.yml/badge.svg)](https://github.com/vaayu-logistics/vaayu/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/Node.js-v22.x-green.svg)](https://nodejs.org/)
[![Flutter Version](https://img.shields.io/badge/Flutter-3.x-blue.svg)](https://flutter.dev/)
[![Android API](https://img.shields.io/badge/Android%20API-35%20(VanillaIceCream)-orange.svg)](https://developer.android.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B-blue.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7%2B-red.svg)](https://redis.io/)
[![Architecture](https://img.shields.io/badge/Architecture-Command--to--Projection-purple.svg)](#architecture-overview)

VAAYU is a high-reliability, real-time operating system for intra-city logistics and mobility, engineered specifically for high-density metropolitan ecosystems (commercial hubs, warehouse gates, industrial corridors, and parcel hubs). 

It enforces a strict separation between **physical custody**, **telemetry transit**, and **financial completion**, backed by an authoritative double-entry accounting ledger with ₹0 imbalance guarantees, monotonic versioning, and zero-trust verification.

---

## Architecture Overview

VAAYU operates on an asynchronous **Command-to-Projection** architecture designed to guarantee consistency across multi-role workflows and offline-prone mobile networks.

```
                  ┌────────────────────────────────────────────────────────┐
                  │               SIX APPLICATION SURFACES                 │
                  │  Customer Mobile │ Driver Mobile │ Merchant Portal     │
                  │  Recipient Track │ Operations    │ Admin / Financial   │
                  └───────────────────────────┬────────────────────────────┘
                                              │ REST (Commands) + WebSocket (Projections)
                                              ▼
                  ┌────────────────────────────────────────────────────────┐
                  │                 VAAYU CORE ENGINE                      │
                  │  Command Bus ──► Domain Rules ──► Authoritative DB     │
                  │  (Idempotency)   (10-State PSM)   (PostgreSQL 16)      │
                  └─────────────┬─────────────────────────────┬────────────┘
                                │ Realtime Broadcast          │ Outbox Event Loop
                                ▼                             ▼
                  ┌───────────────────────────┐ ┌──────────────────────────┐
                  │     REDIS PUB/SUB         │ │ DOUBLE-ENTRY LEDGER      │
                  │  (Ephemeral Telemetry,    │ │ (Paise Math, Immutability│
                  │   Heartbeats & Channels)  │ │  Triggers, Net-Zero Sum) │
                  └─────────────┬─────────────┘ └──────────────────────────┘
                                │
                                ▼
                  ┌────────────────────────────────────────────────────────┐
                  │                 ADAPTER ABSTRACTION                    │
                  │  Map Engine: Local OSRM / Haversine ──► Google Maps    │
                  │  Payments:   Local Ledger Simulator ──► RazorpayX      │
                  │  Storage:    Local Media / Base64   ──► S3 / GCS       │
                  │  SMS / Push: Local OTP Console      ──► FCM / Webhook  │
                  └────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants
1. **Physical Custody $\neq$ Arrival**: Gate arrival, inspection, discrepancy clearance, and mutual OTP exchange are discrete authoritative events before `IN_TRANSIT` status is granted.
2. **Authoritative Financial Completion**: Physical delivery, digital evidence (POD/signatures), and balance settlement are decoupled. Deliberate settlement occurs exactly once under double-entry ledger rules.
3. **Monotonic Version Gating**: All client projections enforce strictly increasing version numbers ($v_{n+1} > v_n$). Stale out-of-order WebSocket or HTTP snapshots are rejected.
4. **Decoupled Telemetry**: High-frequency driver GPS coordinates stream on dedicated sequence-ordered channels without corrupting core trip milestone versioning.
5. **Local-First & Production-Parity**: Core workflows run out-of-the-box using local adapters (OSRM routing, local payment simulator, OTP console) and seamlessly switch to production providers (Google Maps, Razorpay, FCM) via configuration.

---

## Repository Structure

```
vaayu_app/
├── .github/
│   └── workflows/
│       └── ci.yml                      # GitHub Actions CI workflow (Node 22, Postgres, Redis)
├── apps/
│   ├── backend/                        # Node.js / Express Core Engine & Portal Server
│   │   ├── docs/
│   │   │   └── runbooks/               # Standard Operating Procedures (SOPs) & Runbooks
│   │   ├── portal-src/                 # React / JSX Portal Sources (Merchant, Admin, Tracking)
│   │   ├── public/                     # Compiled Portal Assets & Web Cockpits
│   │   │   ├── built/                  # Bundled JavaScript & CSS (esbuild)
│   │   │   └── driver/                 # Lightweight Driver Web Cockpit
│   │   ├── scripts/                    # Portal build, seed, and screenshot audit utilities
│   │   ├── src/
│   │   │   ├── db/                     # PostgreSQL pool, migrations, and persistence store
│   │   │   │   ├── migrations/         # 001-004 SQL double-entry ledger migrations
│   │   │   │   └── data/               # Baseline test fixtures and simulation seeds
│   │   │   ├── http/                   # Modular Express route controllers (30+ routes)
│   │   │   ├── map-engine/             # Routing, geofence, waypoint interpolation, OSRM/Haversine
│   │   │   ├── services/               # Core domain engines & services
│   │   │   │   └── ledger/             # 10-state PSM, OCC versioning, Razorpay provider
│   │   │   └── server_production.js    # Production API server and WebSocket gateway
│   │   ├── test/                       # Comprehensive test suites (50+ unit/integration specs)
│   │   │   ├── payment_simulator/      # Scenario-based payment concurrency & crash recovery
│   │   │   └── unit/                   # Security, ledger, PSM, scale, chaos, Flutter bridge tests
│   │   ├── .env.example                # Backend environment variable template
│   │   └── package.json                # Dependencies and npm test/run commands
│   │
│   └── mobile/                         # Flutter Multi-Role Mobile Application
│       ├── android/                    # Android Native Wrapper (API 35, NDK ABIs)
│       ├── lib/
│       │   ├── core/                   # Transport, WebSocket router, Session, Theme, Tokens
│       │   │   ├── config/             # AppConfig (fail-closed release TLS guards)
│       │   │   ├── network/            # ApiClient, IdempotencyManager, SingleFlightRefresh
│       │   │   ├── persistence/        # LocalPersistenceService, PendingMutationQueue
│       │   │   ├── projection/         # ProjectionStore, DriverLocationStore, OfferStore
│       │   │   ├── resync/             # ResyncCoordinator, OfflineQueueFlusher
│       │   │   └── theme/              # Material 3 Design Tokens, Typography, Colors
│       │   ├── domain/                 # Customer, Driver, Operations, Simulator services
│       │   ├── presentation/           # Cockpits, Cards, Incident Wall, Sheets, Controllers
│       │   │   ├── screens/customer/   # Active ride cockpit, booking, tier selector, fare sheet
│       │   │   ├── screens/driver/     # Active trip cockpit, duty toggle, incoming offer, OTP
│       │   │   ├── screens/operations/ # Live incident wall, fleet status bar, live map
│       │   │   └── simulator/          # 10-Scenario Multi-Role Simulator Shell
│       │   └── main.dart               # Multi-Role Application Entry Point
│       ├── test/
│       │   └── vaayu_mobile_test.dart  # Native Flutter unit tests (42 passing test specs)
│       ├── .env.example                # Mobile environment variable template
│       └── pubspec.yaml                # Flutter dependencies and assets
│
├── .env.compose.example                # Docker Compose environment template
├── .gitignore                          # Production-grade gitignore
├── docker-compose.yml                  # Postgres 16 + PostGIS & Redis 7 services
└── README.md                           # Master system documentation
```

---

## Application Surfaces Guide

| Surface | Target Device / Form Factor | Tech Stack | Entry Point / URL | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **1. Customer Mobile** | iOS / Android Native | Flutter 3.x | `apps/mobile` (`Role.CUSTOMER`) | Ride & intra-city cargo booking, fare transparency, live tracking, OTP release |
| **2. Driver Mobile** | Android Native (API 35) | Flutter 3.x | `apps/mobile` (`Role.DRIVER`) | Shift duty toggle, algorithmic offer sheet, turn-by-turn navigation, PIN verification, POD capture |
| **3. Merchant Web** | Desktop / Tablet Browser | React / Tailwind | `http://localhost:4000/merchant.html` | Batch shipment creation, quoting, automated dispatch, billing statements, bulk CSV |
| **4. Recipient Web** | Mobile / Desktop Browser | React / Vanilla | `http://localhost:4000/public-track.html?token=...` | Zero-login live tracking, driver proximity, PIN presentation, digital receipt |
| **5. Operations Console**| Multi-Monitor Desktop | React / Tailwind | `http://localhost:4000/admin.html` (Operations Tab) | Live fleet map, telemetry anomalies, trip intervention, driver manual re-dispatch |
| **6. Admin & Financial** | Desktop Browser | React / Tailwind | `http://localhost:4000/admin.html` (Finance Tab) | PostgreSQL double-entry audit, reconciliation, dispute resolution, GST reports |
| **Multi-Role Simulator**| Android Tablet / Emulator | Flutter 3.x | `apps/mobile` (`Role.SIMULATOR`) | Interactive harness running 10 automated end-to-end edge-case scenarios |

---

## Prerequisites & Toolchains

| Tool | Required Version | Verification Command | Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 22.0.0` | `node -v` | Core backend runtime and portal bundler |
| **npm** | `>= 10.0.0` | `npm -v` | Package management |
| **Flutter SDK** | `>= 3.24.0` | `flutter --version` | Cross-platform mobile development |
| **Android SDK** | API 35 (Android 15) | `adb --version` | Target build SDK with NDK filters |
| **PostgreSQL** | `>= 15` (16 recommended) | `psql --version` | Production persistence & double-entry ledger |
| **Redis** | `>= 7.0` | `redis-cli --version` | Distributed locks, rate-limiting, and pub/sub |
| **Docker Compose**| `>= 2.20` | `docker compose version` | Optional containerized infrastructure |

---

## Getting Started

### 1. Clone & Infrastructure Initialization

```bash
git clone https://github.com/vaayu-logistics/vaayu.git
cd vaayu
```

To run Postgres and Redis locally using Docker:

```bash
cp .env.compose.example .env
docker compose up -d
```

### 2. Backend Setup & Database Migrations

```bash
cd apps/backend
cp .env.example .env

# Install backend dependencies
npm install

# Run PostgreSQL double-entry ledger migrations
npm run migrate:ledger

# Seed baseline users, fleet owners, drivers, and vehicles
npm run db:seed

# Build portal frontends (React / JSX via esbuild)
node scripts/build-portals.js

# Start backend server
npm start
```
The backend API and portal server will be live at `http://localhost:4000`.

### 3. Mobile Setup & Launch

```bash
cd ../mobile
cp .env.example .env

# Install Flutter dependencies
flutter pub get

# Run on connected Android device or emulator
flutter run
```

To run with explicit network endpoints (e.g. Android Emulator loopback):
```bash
flutter run --dart-define=VAAYU_API_BASE_URL=http://10.0.2.2:4000 --dart-define=VAAYU_WS_BASE_URL=ws://10.0.2.2:4000/ws
```

---

## Running Verification & Test Suites

The VAAYU test suite covers security, accounting invariants, concurrency races, chaos injection, and native mobile state machines.

### Backend Test Commands (from `apps/backend`)

```bash
# Core authentication & OTP security tests
npm test

# 10-State Payment State Machine & API Contract suite
npm run test:psm

# PostgreSQL Double-Entry Ledger Durability & Invariant suite (₹0 imbalance)
npm run test:ledger-pg

# Flutter Bridge & Protocol Transport unit tests
npm run test:flutter:all

# Concurrency & Distributed Lock tests
npm run test:cluster

# Real-time WebSocket resilience & reconnection tests
npm run test:realtime

# Disaster recovery & point-in-time snapshot tests
npm run test:dr

# Full production certification gate
npm run test:final
```

### Mobile Test Commands (from `apps/mobile`)

```bash
# Run 42 native Flutter unit & presentation tests
flutter test

# Verify static analysis & zero lint issues
flutter analyze
```

---

## Configuration & Environment Variables Reference

### Backend (`apps/backend/.env`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | string | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | integer | `4000` | HTTP and WebSocket port |
| `PERSISTENCE_PROVIDER` | string | `sqlite` | Storage engine (`postgres`, `sqlite`, `json`) |
| `DATABASE_URL` | string | - | PostgreSQL connection URL (`postgres://user:pass@host:5432/db`) |
| `REDIS_URL` | string | - | Redis connection URL (`redis://:pass@host:6379`) |
| `JWT_SECRET` | string | - | HS256 secret key for session tokens (min 32 chars) |
| `OTP_HASH_SECRET` | string | - | Salt/hash secret for OTP digests |
| `RAZORPAY_ENABLED` | boolean | `false` | Enable live/sandbox Razorpay provider |
| `RAZORPAY_KEY_ID` | string | - | Razorpay API Key ID |
| `RAZORPAY_KEY_SECRET` | string | - | Razorpay API Key Secret |
| `OSRM_BASE_URL` | string | - | Self-hosted OSRM router endpoint (fallback: Haversine) |

### Mobile (`apps/mobile/.env` or `--dart-define`)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `VAAYU_ENV` | string | `development` | Mobile environment (`development`, `staging`, `production`) |
| `VAAYU_API_BASE_URL` | string | `http://10.0.2.2:4000` | Backend HTTP API root URL |
| `VAAYU_WS_BASE_URL` | string | `ws://10.0.2.2:4000/ws` | Backend WebSocket root URL |
| `VAAYU_ENABLE_DIAGNOSTICS`| boolean| `false` | Enable scenario runner and multi-role simulator shell |
| `VAAYU_LOG_NETWORK_TRAFFIC`| boolean| `false` | Enable verbose HTTP/WS request and response logs |

---

## Current Status & Roadmap

```
[Phase 1: Product Definition]             ===> FROZEN 🔒 (M0 to M4 Milestones Defined)
[Phase 2: Executable Specification]      ===> FROZEN 🔒 (10-State PSM, Command Matrix)
[Phase 3: Authoritative Repository Setup] ===> COMPLETED (Git Hygiene, Clean Commits)
[Phase 4: Client-Backend Integration]     ===> IN PROGRESS (Vertical Slice Commercial Loop)
[Phase 5: Production Provider Hardening]  ===> SCHEDULED (RazorpayX, Google Maps, FCM)
```

---

## License & Security Policy

All code in this repository is proprietary and confidential. Unauthorized copying, modification, or distribution is strictly prohibited. For security vulnerability disclosures, contact `security@vaayu.in`.
