// apps/backend/src/services/s3.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Magic-byte signatures per accepted MIME type.
// Checked AFTER multipart buffering to catch mismatched Content-Type headers —
// user-supplied MIME claims are not trustworthy.
const MAGIC: Record<string, Buffer[]> = {
  "application/pdf": [Buffer.from("%PDF")],
  "image/jpeg":      [Buffer.from([0xff, 0xd8, 0xff])],
  "image/png":       [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  "image/tiff":      [
    Buffer.from([0x49, 0x49, 0x2a, 0x00]), // little-endian II*\0
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), // big-endian MM\0*
  ],
};

export const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg":      "jpg",
  "image/png":       "png",
  "image/tiff":      "tif",
};

export function checkMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const sigs = MAGIC[mimeType];
  if (!sigs) return false;
  return sigs.some((sig) => buffer.subarray(0, sig.length).equals(sig));
}

export interface S3UploadParams {
  bucket: string;
  key: string;
  body: Buffer;
  mimeType: string;
  kmsKeyId?: string;
}

let _s3: S3Client | undefined;

function getS3(): S3Client {
  return (_s3 ??= new S3Client({ region: process.env.AWS_REGION ?? "af-south-1" }));
}

export async function uploadToS3(params: S3UploadParams): Promise<void> {
  const { bucket, key, body, mimeType, kmsKeyId } = params;
  await getS3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimeType,
      ...(kmsKeyId
        ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: kmsKeyId }
        : {}),
    }),
  );
}
