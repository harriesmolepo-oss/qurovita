import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Modal,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import QRCode from 'react-native-qrcode-svg';
import { Q } from '@nozbe/watermelondb';
import { unhex } from '@qurovita/crypto';

import { useAuthContext } from '../../src/auth/AuthContext';
import { API_BASE_URL } from '../../src/config/api';
import { getDatabase } from '../../src/database';
import FhirResource from '../../src/database/models/FhirResource';
import {
  generatePatientEcdhKeypair,
  persistPatientEcdhKeys,
  clearPatientEcdhKeys,
} from '../../src/services/crypto-session';
import {
  startP2PTransfer,
  stopP2PTransfer,
  type TransferStatus,
  type QrSessionContext,
} from '../../src/services/p2p-transfer';
import { pullOnly } from '../../src/database/sync';

type ScreenState = 'idle' | 'loading' | 'qr_active' | 'success' | 'error';

interface QrSessionResponse {
  session_id: string;
  qr_bytes_hex: string;
  server_pub_compressed_hex: string;
  expires_at: string;
  websocket_url: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function resolveBleMac(): string {
  // react-native-ble-plx does not expose a stable peripheral MAC on Android 12+.
  return Platform.OS === 'android' ? '02:00:00:00:00:00' : '00:00:00:00:00:00';
}

function buildShareBundle(resources: FhirResource[]): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: resources.map((r) => ({ resource: r.resource })),
  });
}

export default function ShareRecordsScreen() {
  const { t } = useTranslation();
  const { jwt } = useAuthContext();

  const [records, setRecords] = useState<FhirResource[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [wifiDirectOptIn, setWifiDirectOptIn] = useState(false);
  const [screenState, setScreenState] = useState<ScreenState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [transferStatus, setTransferStatus] = useState<TransferStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const sessionRef = useRef<QrSessionContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const db = getDatabase();
    const collection = db.get<FhirResource>('fhir_resources');
    const subscription = collection
      .query(Q.where('is_deleted', false), Q.sortBy('server_updated_at', Q.desc))
      .observe()
      .subscribe((rows) => {
        setRecords(rows);
      });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!jwt) return;
    setSyncing(true);
    void pullOnly(jwt)
      .catch(() => undefined)
      .finally(() => setSyncing(false));
  }, [jwt]);

  const allSelected = useMemo(
    () => records.length > 0 && selectedIds.size === records.length,
    [records.length, selectedIds.size],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(records.map((r) => r.id)));
    }
  }, [allSelected, records]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetSessionUi = useCallback(() => {
    clearTimer();
    stopP2PTransfer();
    void clearPatientEcdhKeys();
    setQrValue(null);
    setSessionId(null);
    setExpiresAtMs(null);
    setSecondsLeft(0);
    setTransferStatus(null);
    sessionRef.current = null;
    setScreenState('idle');
  }, [clearTimer]);

  const startCountdown = useCallback((expiryMs: number) => {
    clearTimer();
    const tick = () => {
      const remaining = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        clearTimer();
        stopP2PTransfer();
        void clearPatientEcdhKeys();
        setQrValue(null);
        setSessionId(null);
        setScreenState('error');
        setErrorMessage(t('share.errorSessionExpired'));
      }
    };
    tick();
    timerRef.current = setInterval(tick, 250);
  }, [clearTimer, resetSessionUi, t]);

  const handleGenerateQr = async () => {
    if (!jwt || selectedIds.size === 0) return;
    setScreenState('loading');
    setErrorMessage(null);

    try {
      const selected = records.filter((r) => selectedIds.has(r.id));
      const keyMaterial = await generatePatientEcdhKeypair();
      await persistPatientEcdhKeys(keyMaterial);

      const res = await fetch(`${API_BASE_URL}/qr-sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          patient_pub_compressed_hex: keyMaterial.publicKeyHex,
          ble_mac: resolveBleMac(),
        }),
      });

      if (!res.ok) {
        throw new Error(t('share.errorCreateSession'));
      }

      const session = (await res.json()) as QrSessionResponse;
      const qrBytes = unhex(session.qr_bytes_hex);
      const qrText = bytesToBase64(qrBytes);

      const expiryMs = new Date(session.expires_at).getTime();
      const ctx: QrSessionContext = {
        sessionId: session.session_id,
        qrBytesHex: session.qr_bytes_hex,
        serverPubCompressedHex: session.server_pub_compressed_hex,
        websocketUrl: session.websocket_url,
        expiresAt: session.expires_at,
        jwt,
      };

      sessionRef.current = ctx;
      setSessionId(session.session_id);
      setQrValue(qrText);
      setExpiresAtMs(expiryMs);
      setScreenState('qr_active');
      startCountdown(expiryMs);

      const bundleJson = buildShareBundle(selected);
      startP2PTransfer({
        bundleJson,
        session: ctx,
        wifiDirectOptIn,
        onStatus: setTransferStatus,
      });
    } catch (e) {
      setScreenState('error');
      setErrorMessage(
        e instanceof Error ? e.message : t('share.errorUnknown'),
      );
      await clearPatientEcdhKeys();
    }
  };

  const handleRevoke = async () => {
    if (!jwt || !sessionId) return;
    setScreenState('loading');
    try {
      await fetch(`${API_BASE_URL}/qr-sessions/${sessionId}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      setScreenState('success');
      resetSessionUi();
    } catch {
      setScreenState('error');
      setErrorMessage(t('share.errorRevokeFailed'));
    }
  };

  useEffect(() => () => {
    clearTimer();
    stopP2PTransfer();
  }, [clearTimer]);

  const formatTimer = (totalSec: number): string => {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const renderRecord = ({ item }: { item: FhirResource }) => {
    const checked = selectedIds.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.recordRow, checked && styles.recordRowSelected]}
        onPress={() => toggleSelect(item.id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <View style={[styles.checkbox, checked && styles.checkboxOn]} />
        <View style={styles.recordBody}>
          <Text style={styles.recordTitle}>{item.displayTitle}</Text>
          <Text style={styles.recordMeta}>
            {item.resourceType}
            {item.displayDate ? ` · ${item.displayDate}` : ''}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const showQr = screenState === 'qr_active' && qrValue;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('share.title')}</Text>
      <Text style={styles.subtitle}>{t('share.subtitle')}</Text>

      {syncing ? (
        <View style={styles.syncRow}>
          <ActivityIndicator size="small" color="#0066cc" />
          <Text style={styles.syncText}>{t('share.syncing')}</Text>
        </View>
      ) : null}

      <TouchableOpacity style={styles.selectAllRow} onPress={toggleSelectAll}>
        <Text style={styles.selectAllText}>{t('share.selectAll')}</Text>
        <Text style={styles.selectCount}>
          {t('share.selectedCount', { count: selectedIds.size })}
        </Text>
      </TouchableOpacity>

      {records.length === 0 ? (
        <Text style={styles.empty}>{t('share.noRecords')}</Text>
      ) : (
        <FlatList
          data={records}
          keyExtractor={(item) => item.id}
          renderItem={renderRecord}
          style={styles.list}
          contentContainerStyle={styles.listContent}
        />
      )}

      <View style={styles.wifiRow}>
        <View style={styles.wifiLabels}>
          <Text style={styles.wifiTitle}>{t('share.wifiDirectTitle')}</Text>
          <Text style={styles.wifiHint}>{t('share.wifiDirectHint')}</Text>
        </View>
        <Switch
          value={wifiDirectOptIn}
          onValueChange={setWifiDirectOptIn}
          accessibilityLabel={t('share.wifiDirectTitle')}
        />
      </View>

      <TouchableOpacity
        style={[
          styles.primaryButton,
          (selectedIds.size === 0 || screenState === 'loading') && styles.buttonDisabled,
        ]}
        onPress={() => void handleGenerateQr()}
        disabled={selectedIds.size === 0 || screenState === 'loading' || !!showQr}
      >
        {screenState === 'loading' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>{t('share.generateQr')}</Text>
        )}
      </TouchableOpacity>

      {showQr ? (
        <View style={styles.qrCard}>
          <View style={styles.qrHeader}>
            <Text style={styles.qrLabel}>{t('share.qrInstructions')}</Text>
            <Text
              style={[
                styles.timer,
                secondsLeft < 60 && styles.timerWarn,
                secondsLeft < 30 && styles.timerCritical,
              ]}
            >
              {formatTimer(secondsLeft)}
            </Text>
          </View>
          <View style={styles.qrBox}>
            <QRCode value={qrValue} size={220} />
          </View>
          <Text style={styles.sessionIdLabel}>{t('share.sessionId')}</Text>
          <Text style={styles.sessionId} selectable>
            {sessionId}
          </Text>
          {transferStatus ? (
            <Text style={styles.transferStatus}>
              {t('share.transferStatus', {
                phase: transferStatus.phase,
                transport: transferStatus.transport,
              })}
            </Text>
          ) : null}
          <TouchableOpacity
            style={styles.revokeButton}
            onPress={() => void handleRevoke()}
          >
            <Text style={styles.revokeText}>{t('share.revokeSession')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={screenState === 'error'} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <Text style={styles.overlayTitle}>{t('share.errorTitle')}</Text>
            <Text style={styles.overlayBody}>
              {errorMessage ?? t('share.errorUnknown')}
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                setScreenState('idle');
                setErrorMessage(null);
              }}
            >
              <Text style={styles.primaryButtonText}>{t('share.dismiss')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={screenState === 'success'} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <Text style={styles.overlayTitle}>{t('share.revokedTitle')}</Text>
            <Text style={styles.overlayBody}>{t('share.revokedBody')}</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => setScreenState('idle')}
            >
              <Text style={styles.primaryButtonText}>{t('share.dismiss')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a2e',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
    marginBottom: 12,
  },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  syncText: {
    fontSize: 13,
    color: '#666',
  },
  selectAllRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  selectAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0066cc',
  },
  selectCount: {
    fontSize: 13,
    color: '#666',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 8,
    gap: 8,
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: '#e8e8e8',
  },
  recordRowSelected: {
    borderColor: '#0066cc',
    backgroundColor: '#f0f7ff',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#0066cc',
  },
  checkboxOn: {
    backgroundColor: '#0066cc',
  },
  recordBody: {
    flex: 1,
  },
  recordTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  recordMeta: {
    fontSize: 12,
    color: '#777',
    marginTop: 2,
  },
  empty: {
    flex: 1,
    textAlign: 'center',
    color: '#888',
    fontSize: 14,
    paddingVertical: 24,
  },
  wifiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 12,
  },
  wifiLabels: {
    flex: 1,
  },
  wifiTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  wifiHint: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
    lineHeight: 16,
  },
  primaryButton: {
    backgroundColor: '#0066cc',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  qrCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    alignItems: 'center',
  },
  qrHeader: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  qrLabel: {
    flex: 1,
    fontSize: 13,
    color: '#444',
    paddingRight: 8,
  },
  timer: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0066cc',
  },
  timerWarn: {
    color: '#e67e00',
  },
  timerCritical: {
    color: '#cc0000',
  },
  qrBox: {
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  sessionIdLabel: {
    marginTop: 12,
    fontSize: 12,
    color: '#888',
  },
  sessionId: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#333',
    marginTop: 4,
  },
  transferStatus: {
    marginTop: 8,
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
  },
  revokeButton: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cc0000',
  },
  revokeText: {
    color: '#cc0000',
    fontWeight: '600',
    fontSize: 14,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  overlayCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
  },
  overlayTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  overlayBody: {
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
    marginBottom: 16,
  },
});
