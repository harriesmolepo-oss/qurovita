import { API_BASE_URL } from '../config/api';
import { useAuthContext } from './AuthContext';

export function useAuth() {
  const ctx = useAuthContext();

  const requestOtp = async (phone: string): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/auth/otp-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(typeof body.error === 'string' ? body.error : 'Failed to request OTP');
    }
  };

  // 🔴 HUMAN ACTION NEEDED — backend /auth/otp-verify does not yet accept or
  // store consent fields. The fields below (consent_hash, consent_version,
  // language) are sent but silently ignored by the current implementation.
  //
  // Before patient #1: update apps/backend/src/auth.ts otp-verify handler to:
  //   1. Accept { phone, otp, consent_hash, consent_version, language }
  //   2. Write a consent_records row: (user_id, consent_text_sha256, language, timestamp)
  //   3. Return { token, consent_record_id } so the mobile can confirm persistence
  //
  // Without this update, POPIA consent is collected on-device but not audited server-side.
  const verifyOtp = async (
    phone: string,
    otp: string,
    consentHash: string,
    consentVersion: string,
    language: string,
  ): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/auth/otp-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        otp,
        consent_hash: consentHash,
        consent_version: consentVersion,
        language,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(typeof body.error === 'string' ? body.error : 'Failed to verify OTP');
    }
    const { token } = await res.json() as { token: string };
    // kyc_status not returned by the current backend — default to kyc_pending
    // so the user sees the KYC placeholder screen after first sign-up.
    await ctx.signIn(token, false);
  };

  return { ...ctx, requestOtp, verifyOtp };
}
