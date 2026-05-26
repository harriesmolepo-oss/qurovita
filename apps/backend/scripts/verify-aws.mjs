// apps/backend/scripts/verify-aws.mjs
// Verifies the IAM user, S3 bucket, and both KMS keys are reachable
// using the credentials in .env.local. Read-only — no resources created.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { KMSClient, DescribeKeyCommand } from "@aws-sdk/client-kms";

// Load .env.local (dotenv loads .env by default; we need .local too)
import { config } from "dotenv";
config({ path: ".env.local", override: true });

const required = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_S3_BUCKET",
  "AWS_KMS_KEY_ID",
  "AWS_KMS_WRAP_KEY_ID",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("MISSING env vars:", missing);
  process.exit(1);
}

const region = process.env.AWS_REGION;
console.log(`region: ${region}`);
console.log(`bucket: ${process.env.AWS_S3_BUCKET}`);

const s3 = new S3Client({ region });
const kms = new KMSClient({ region });

try {
  const r = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.AWS_S3_BUCKET, MaxKeys: 1 }),
  );
  console.log(`S3 OK: bucket reachable, ${r.KeyCount ?? 0} objects`);
} catch (err) {
  console.error("S3 FAILED:", err.name, err.message);
  process.exit(1);
}

try {
  const r = await kms.send(
    new DescribeKeyCommand({ KeyId: process.env.AWS_KMS_KEY_ID }),
  );
  console.log(
    `KMS docs OK: ${r.KeyMetadata.KeyUsage}, ${r.KeyMetadata.KeySpec}, ${r.KeyMetadata.Enabled ? "Enabled" : "Disabled"}`,
  );
} catch (err) {
  console.error("KMS docs FAILED:", err.name, err.message);
  process.exit(1);
}

try {
  const r = await kms.send(
    new DescribeKeyCommand({ KeyId: process.env.AWS_KMS_WRAP_KEY_ID }),
  );
  console.log(
    `KMS signing OK: ${r.KeyMetadata.KeyUsage}, ${r.KeyMetadata.KeySpec}, ${r.KeyMetadata.Enabled ? "Enabled" : "Disabled"}`,
  );
  if (r.KeyMetadata.KeySpec !== "ECC_NIST_P256") {
    console.warn("WARNING: signing key spec is not ECC_NIST_P256");
  }
} catch (err) {
  console.error("KMS signing FAILED:", err.name, err.message);
  process.exit(1);
}

console.log("\nAWS wiring verified");
