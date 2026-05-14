# @qurovita/backend

Fastify 4 + TypeScript 5 backend for the QuroVita v0 demo.

## Signing key modes

| `NODE_ENV` | Key source | AWS account needed? |
|---|---|---|
| `development` (default) | `.keys/` file cache — generated on first run | No |
| `production` | AWS KMS asymmetric key (`ECC_NIST_P256`, `SIGN_VERIFY`) | Yes |

### Dev setup

```bash
cp .env.example .env
# edit DATABASE_URL if your Postgres is not on localhost:5433
pnpm dev
```

The `.keys/` directory is gitignored. Delete it to rotate the dev signing key.

### Production setup

1. Create a KMS asymmetric key in `af-south-1`: type `ECC_NIST_P256`, usage `SIGN_VERIFY`.
2. Set `AWS_KMS_KEY_ID` and `NODE_ENV=production` in your environment (AWS Secrets Manager in prod).
3. Grant the IAM role running this service `kms:GetPublicKey` and `kms:Sign` on that key.

The private key never leaves KMS. `GET /keys/ecdsa` returns the compressed public key for QR verification.

## Dev database

```bash
docker compose up -d          # starts postgres on port 5433
pnpm migrate                  # applies supabase/migrations/*.sql in order
```

## Running

```bash
pnpm dev      # tsx watch — hot reload
pnpm start    # tsx — single run
pnpm test     # vitest
```
