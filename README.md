# QuroVita — Today Demo (v0)

The architecturally novel piece of QuroVita running on your laptop in ~10 minutes.

**What this proves:** patient generates a QR → provider scans → encrypted FHIR bundle
transfers from patient → provider → renders read-only with the source-of-truth banner.
Tamper detection, expiry, and audit logging all working.

**What this skips for now:** BLE (uses WebSocket instead — same crypto, different
transport), KYC, OCR, AI assistant, WhatsApp, SAHPRA filings, AWS deployment.
All added in days 2-7 per the build plan.

---

## Run it on Windows (10 min)

### 1. Install prerequisites (skip any you have)

Open **PowerShell as Administrator** and run:

```powershell
# Check Node version — need 20+
node --version

# If Node is missing or below 20, install via winget:
winget install OpenJS.NodeJS.LTS

# Check Docker is running
docker --version
docker ps
```

If `docker ps` errors, open Docker Desktop and wait for it to say "Engine running".

### 2. Start the database

In a regular PowerShell (not admin), from the repo root:

```powershell
docker compose up -d
```

Wait ~10 seconds for Postgres to be ready.

### 3. Install and run the backend

```powershell
cd backend
npm install
npm run migrate
npm run dev
```

Leave this terminal running. You should see `Server listening on http://localhost:3000`.

### 4. Open the demo

Open **two browser tabs**:

- **Patient tab:** http://localhost:3000/patient
- **Provider tab:** http://localhost:3000/provider

### 5. Try the flow

1. In the **patient** tab, click **"Generate Share QR"**. A QR code appears with a 60-second timer.
2. Look at the patient tab URL bar — copy the session ID shown under the QR.
3. In the **provider** tab, paste the session ID and click **"Open Session"**.
4. The provider tab connects via WebSocket, the patient encrypts and sends the FHIR Bundle, the provider decrypts and renders it read-only.
5. Try the **"Tamper test"** button on the provider tab — it'll show how a modified QR is rejected by the ECDSA signature check.

---

## What's inside

```
qurovita-today/
├── docker-compose.yml        # Postgres 15 on port 5432
├── backend/
│   ├── src/
│   │   ├── server.ts         # Fastify + static + WebSocket
│   │   ├── crypto/
│   │   │   └── qr-session.ts # OOB handshake — the architecturally novel piece
│   │   ├── routes/
│   │   │   ├── qr.ts         # POST /qr-sessions, GET /qr-sessions/:id
│   │   │   └── ws.ts         # WebSocket bundle transfer
│   │   ├── services/
│   │   │   ├── audit.ts      # Append-only audit log
│   │   │   └── sample-fhir.ts# Sample FHIR Bundle to share
│   │   └── db.ts
│   └── migrations/
│       └── 0001_init.sql
└── clients/
    ├── patient/index.html    # Generates QR, encrypts + sends bundle
    └── provider/index.html   # Verifies QR, receives + decrypts bundle
```

## Map to the v2.0 architecture

| v2.0 piece                  | Today's demo                                | Day 2+ replacement                   |
|-----------------------------|---------------------------------------------|--------------------------------------|
| OOB QR + ECDH + ECDSA       | **Same — exact production code**            | unchanged                            |
| AES-256-GCM bundle wrap     | **Same — exact production code**            | unchanged                            |
| BLE / Wi-Fi Direct P2P      | WebSocket over localhost                    | swap transport layer                 |
| Postgres + append-only audit| **Same — same SQL schema fragment**         | move to Supabase af-south-1          |
| FHIR Bundle                 | Sample HIV/TB/NCD bundle                    | real patient resources from app      |
| Read-only provider render   | **Same — banner included**                  | unchanged                            |
| OCR / AI / WhatsApp / KYC   | Out of scope for v0                         | added days 2-7                       |

---

## Troubleshooting

- **Port 5432 already in use** → another Postgres is running. Stop it, or edit `docker-compose.yml` to use 5433 and update `backend/.env`.
- **`npm install` fails on `node-gyp`** → install windows-build-tools: `npm install --global windows-build-tools` (or accept it — we don't need native modules).
- **Camera scanning doesn't work** → use the "Paste session ID" path in the provider tab. Camera scan requires HTTPS in most browsers; the manual path works on localhost HTTP.
- **`pnpm` not found** → we use plain `npm` here, no pnpm needed.
