import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export const POPIA_CONSENT_VERSION = '1.0';

// This text is the legal source of truth. Any change produces a different
// SHA-256 hash, breaking the consent_records audit trail — treat like the AI
// system prompt: do not modify without legal sign-off.
export const POPIA_CONSENT_TEXT =
  `QuroVita Health Records — Privacy Notice (POPIA)\n` +
  `\n` +
  `By using QuroVita you agree to the following:\n` +
  `\n` +
  `1. Your health records are stored on servers in South Africa (AWS Cape Town, af-south-1). No data leaves South Africa.\n` +
  `\n` +
  `2. You control who sees your records. Sharing is always initiated by you via a QR code you generate. You can revoke access at any time.\n` +
  `\n` +
  `3. QuroVita does not sell or share your information with third parties without your explicit consent.\n` +
  `\n` +
  `4. QuroVita processes your personal information in compliance with the Protection of Personal Information Act 4 of 2013 (POPIA).\n` +
  `\n` +
  `5. You have the right to access, correct, and request deletion of your personal information. Contact: privacy@qurovita.co.za\n` +
  `\n` +
  `6. By proceeding you confirm that you are the patient or their legal guardian and that you accept these terms.`;

export const POPIA_CONSENT_SHA256: string = bytesToHex(
  sha256(new TextEncoder().encode(POPIA_CONSENT_TEXT)),
);
