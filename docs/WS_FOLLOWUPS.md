# WS follow-up items

Deferred from the ws.ts post-0007 rewrite (commit 05422d2).

---

## 1. C2.a — Patient JWT on WS

`/shared/ws/:sessionId` is currently fully auth-exempt. Patient connections
should present `?token=<JWT>` and the handler should verify
`jwt.sub === row.patient_user_id`. Provider connections continue to
authenticate by knowledge of the session UUID alone.

**Blocked on:**
- Patient mobile client must append the JWT to the WS URL
  (`apps/mobile/src/services/p2p-transfer.ts:337` builds the URL from
  `session.websocketUrl` — the calling screen code needs to append
  `&token=${session.jwt}`)
- HTML demo needs the broader API alignment first (see item 2)

---

## 2. HTML patient demo API alignment

`apps/backend/public/patient/index.html` uses pre-OOB-rewrite field names
that no longer match the current backend response.

| Current HTML field | Correct field (post-OOB) |
|---|---|
| `patient_pub_compressed_hex` (hex) | `patientPubKey` (base64) |
| `session.session_id` | `session.sessionId` |
| `session.qr_bytes_hex` | `session.payload` |
| `session.server_pub_compressed_hex` | *(derive from payload CBOR)* |
| `session.websocket_url` | *(not yet returned — must be added to response or constructed client-side)* |

Five fields misaligned. The WS connection currently fails because
`websocket_url` is `undefined` in the response, producing
`"undefined?role=patient"` as the URL. Touches `index.html` and
`crypto.js`.

---

## 3. Mobile p2p-transfer WS URL source

`apps/mobile/src/services/p2p-transfer.ts:337` reads `session.websocketUrl`
from `QrSessionContext`. Wherever that context is constructed (screen code
not surfaced in commit 05422d2), the `websocketUrl` field must point at
`/shared/ws/${sessionId}` instead of the old `/ws/${sessionId}`.
