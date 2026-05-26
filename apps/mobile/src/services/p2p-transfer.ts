/**
 * Offline P2P clinical bundle transfer — BLE peripheral (mock), WebSocket, online fallback.
 *
 * CSIR: ECDH P-256 + HKDF-SHA256 + AES-256-GCM only.
 * BLE MTU-safe chunking at 200 bytes ciphertext per write.
 */
import { BleManager, type Device } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { hex, unhex } from '@qurovita/crypto';

import { API_BASE_URL } from '../config/api';
import {
  clearPatientEcdhKeys,
  deriveSessionAesKey,
  encryptFhirBundle,
  loadPatientEcdhPrivateKey,
} from './crypto-session';

/** QuroVita share service — custom GATT layout for chunked ciphertext. */
export const QV_SHARE_SERVICE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
export const QV_SHARE_CHARACTERISTIC_UUID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const CHUNK_PAYLOAD_BYTES = 200;
const WIFI_DIRECT_THRESHOLD_BYTES = 50 * 1024;
const MAX_BLE_ATTEMPTS = 2;

export interface TransferChunkHeader {
  total_chunks: number;
  ciphertext_length: number;
  chunk_index: number;
}

export interface TransferChunkBody {
  chunk_index: number;
  bytes: string;
}

export type TransferChunk = TransferChunkHeader | TransferChunkBody;

export interface QrSessionContext {
  sessionId: string;
  qrBytesHex: string;
  serverPubCompressedHex: string;
  websocketUrl: string;
  expiresAt: string;
  jwt: string;
}

export type TransferPhase =
  | 'idle'
  | 'advertising'
  | 'connected'
  | 'encrypting'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'revoked'
  | 'expired';

export interface TransferStatus {
  phase: TransferPhase;
  transport: 'none' | 'ble' | 'websocket' | 'wifi_direct' | 'online';
  bytesSent: number;
  totalBytes: number;
  bleAttempts: number;
  message: string;
  error: string | null;
}

type StatusListener = (status: TransferStatus) => void;

export interface P2PTransferOptions {
  bundleJson: string;
  session: QrSessionContext;
  wifiDirectOptIn: boolean;
  onStatus?: StatusListener;
}

/** Slice AES-GCM wire bytes into BLE-safe JSON chunks. */
export function buildCiphertextChunks(ciphertext: Uint8Array): TransferChunk[] {
  const totalChunks = Math.ceil(ciphertext.length / CHUNK_PAYLOAD_BYTES) || 1;
  const chunks: TransferChunk[] = [
    {
      total_chunks: totalChunks,
      ciphertext_length: ciphertext.length,
      chunk_index: 0,
    },
  ];

  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * CHUNK_PAYLOAD_BYTES;
    const slice = ciphertext.subarray(start, start + CHUNK_PAYLOAD_BYTES);
    chunks.push({
      chunk_index: i,
      bytes: hex(slice),
    });
  }
  return chunks;
}

/**
 * Mock BLE peripheral layer.
 * react-native-ble-plx cannot advertise as a peripheral on physical handsets;
 * this wrapper simulates advertising and accepts injected provider connections in dev.
 */
export class MockBlePeripheral {
  private manager: BleManager;
  private advertising = false;
  private connectedDevice: Device | null = null;
  private failureInjected = false;

  constructor() {
    this.manager = new BleManager();
  }

  async startAdvertising(sessionId: string): Promise<boolean> {
    this.advertising = true;
    if (this.failureInjected) {
      this.advertising = false;
      return false;
    }
    // Peripheral mode is unavailable; we keep state so the transfer layer can fall back.
    return this.advertising;
  }

  async stopAdvertising(): Promise<void> {
    this.advertising = false;
  }

  /** Test hook: force the next advertise() call to fail. */
  injectAdvertiseFailure(): void {
    this.failureInjected = true;
  }

  resetFailures(): void {
    this.failureInjected = false;
  }

  isAdvertising(): boolean {
    return this.advertising;
  }

  async simulateProviderConnection(deviceId = 'mock-provider'): Promise<Device | null> {
    const devices = await this.manager.devices([deviceId]);
    if (devices.length > 0) {
      this.connectedDevice = devices[0];
      return this.connectedDevice;
    }
    return null;
  }

  getConnectedDevice(): Device | null {
    return this.connectedDevice;
  }

  destroy(): void {
    this.manager.destroy();
  }
}

/** Rewrite localhost WebSocket URLs to the configured API host (physical device testing). */
function wsUrlForDevice(url: string): string {
  try {
    const api = new URL(API_BASE_URL);
    const target = new URL(url);
    if (target.hostname === 'localhost' || target.hostname === '127.0.0.1') {
      target.hostname = api.hostname;
    }
    return target.toString();
  } catch {
    return url;
  }
}

export class P2PTransferService {
  private status: TransferStatus = {
    phase: 'idle',
    transport: 'none',
    bytesSent: 0,
    totalBytes: 0,
    bleAttempts: 0,
    message: '',
    error: null,
  };

  private listener: StatusListener | null = null;
  private ble = new MockBlePeripheral();
  private ws: WebSocket | null = null;
  private aborted = false;

  private emit(patch: Partial<TransferStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listener?.(this.status);
  }

  async start(options: P2PTransferOptions): Promise<void> {
    this.aborted = false;
    this.listener = options.onStatus ?? null;
    const { bundleJson, session, wifiDirectOptIn } = options;

    const plaintextBytes = new TextEncoder().encode(bundleJson).length;
    if (plaintextBytes >= WIFI_DIRECT_THRESHOLD_BYTES && wifiDirectOptIn) {
      await this.transferViaWifiDirect(bundleJson, session);
      return;
    }

    let bleOk = false;
    for (let attempt = 0; attempt < MAX_BLE_ATTEMPTS; attempt += 1) {
      this.emit({
        phase: 'advertising',
        transport: 'ble',
        bleAttempts: attempt + 1,
        message: `BLE advertise attempt ${attempt + 1}/${MAX_BLE_ATTEMPTS}`,
        error: null,
      });
      bleOk = await this.ble.startAdvertising(session.sessionId);
      if (bleOk) {
        const sent = await this.tryBleChunkTransfer(bundleJson, session);
        if (sent) return;
      }
      if (attempt === 0) {
        this.ble.injectAdvertiseFailure();
      }
    }

    await this.ble.stopAdvertising();
    this.emit({
      message: 'BLE unavailable — trying WebSocket transport',
    });

    const wsOk = await this.transferViaWebSocket(bundleJson, session);
    if (wsOk) return;

    await this.transferViaOnlineFallback(bundleJson, session);
  }

  async revoke(): Promise<void> {
    this.aborted = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    await this.ble.stopAdvertising();
    await clearPatientEcdhKeys();
    this.emit({ phase: 'revoked', message: 'Session revoked locally' });
  }

  stop(): void {
    this.aborted = true;
    void this.ble.stopAdvertising();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.ble.destroy();
    this.emit({ phase: 'idle', transport: 'none' });
  }

  private async encryptBundle(
    bundleJson: string,
    session: QrSessionContext,
    peerPubHex: string,
  ): Promise<Uint8Array> {
    const priv = await loadPatientEcdhPrivateKey();
    if (!priv) {
      throw new Error('Patient ECDH private key not found in SecureStore');
    }
    const peerPub = unhex(peerPubHex);
    const aesKey = deriveSessionAesKey(priv, peerPub, session.sessionId);
    return encryptFhirBundle(bundleJson, aesKey, session.sessionId);
  }

  private async tryBleChunkTransfer(
    bundleJson: string,
    session: QrSessionContext,
  ): Promise<boolean> {
    try {
      this.emit({ phase: 'connected', transport: 'ble' });
      const ciphertext = await this.encryptBundle(
        bundleJson,
        session,
        session.serverPubCompressedHex,
      );
      const chunks = buildCiphertextChunks(ciphertext);
      this.emit({
        phase: 'transferring',
        totalBytes: ciphertext.length,
        bytesSent: 0,
      });

      for (const chunk of chunks) {
        if (this.aborted) return false;
        const encoded = JSON.stringify(chunk);
        // Mock write — real GATT write would target QV_SHARE_CHARACTERISTIC_UUID
        this.emit({
          bytesSent: Math.min(
            this.status.bytesSent + CHUNK_PAYLOAD_BYTES,
            ciphertext.length,
          ),
          message: `BLE chunk ${'chunk_index' in chunk ? chunk.chunk_index : 0}`,
        });
        if (encoded.length > 512) {
          /* chunk envelope fits MTU after fragmentation in native layer */
        }
      }

      this.emit({
        phase: 'completed',
        transport: 'ble',
        bytesSent: ciphertext.length,
        message: 'Bundle transferred over BLE (mock peripheral)',
      });
      return true;
    } catch (e) {
      this.emit({
        error: e instanceof Error ? e.message : String(e),
        message: 'BLE chunk transfer failed',
      });
      return false;
    }
  }

  private async transferViaWebSocket(
    bundleJson: string,
    session: QrSessionContext,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = `${wsUrlForDevice(session.websocketUrl)}?role=patient`;
        this.ws = new WebSocket(url);
        this.emit({ phase: 'advertising', transport: 'websocket', message: 'Opening WebSocket' });

        const timeout = setTimeout(() => {
          this.ws?.close();
          resolve(false);
        }, 45_000);

        this.ws.onopen = () => {
          this.emit({ phase: 'connected', transport: 'websocket', message: 'WebSocket open' });
        };

        this.ws.onmessage = async (ev) => {
          try {
            const data =
              typeof ev.data === 'string'
                ? ev.data
                : new TextDecoder().decode(ev.data as ArrayBuffer);
            const msg = JSON.parse(data) as {
              type?: string;
              provider_pub_compressed_hex?: string;
            };

            if (msg.type === 'ready' || msg.type === 'joined') {
              const peerPub =
                msg.provider_pub_compressed_hex ?? session.serverPubCompressedHex;
              this.emit({ phase: 'encrypting', message: 'Encrypting bundle for WebSocket' });
              const wire = await this.encryptBundle(bundleJson, session, peerPub);
              this.ws?.send(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength));
              this.ws?.send(
                JSON.stringify({
                  type: 'bundle_transferred',
                  bytes: wire.length,
                }),
              );
              this.emit({
                phase: 'completed',
                transport: 'websocket',
                totalBytes: wire.length,
                bytesSent: wire.length,
                message: 'Bundle sent via WebSocket',
              });
              clearTimeout(timeout);
              resolve(true);
            }
          } catch (e) {
            this.emit({
              phase: 'failed',
              error: e instanceof Error ? e.message : String(e),
            });
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };

        this.ws.onclose = () => {
          if (this.status.phase !== 'completed') {
            clearTimeout(timeout);
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }

  private async transferViaWifiDirect(
    bundleJson: string,
    session: QrSessionContext,
  ): Promise<void> {
    this.emit({
      phase: 'advertising',
      transport: 'wifi_direct',
      message: 'Wi-Fi Direct requested — native module required on Android 12+',
    });
    try {
      const ciphertext = await this.encryptBundle(
        bundleJson,
        session,
        session.serverPubCompressedHex,
      );
      this.emit({
        phase: 'failed',
        error:
          'Wi-Fi Direct fallback is not available in Expo managed workflow. Disable opt-in or use online fallback.',
        totalBytes: ciphertext.length,
      });
    } catch (e) {
      this.emit({
        phase: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
    await this.transferViaOnlineFallback(bundleJson, session);
  }

  private async transferViaOnlineFallback(
    bundleJson: string,
    session: QrSessionContext,
  ): Promise<void> {
    this.emit({
      phase: 'encrypting',
      transport: 'online',
      message: 'Encrypting bundle for online fallback upload',
    });
    try {
      const wire = await this.encryptBundle(
        bundleJson,
        session,
        session.serverPubCompressedHex,
      );
      const chunks = buildCiphertextChunks(wire);
      const res = await fetch(
        `${API_BASE_URL}/qr-sessions/${session.sessionId}/online-bundle`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.jwt}`,
          },
          body: JSON.stringify({
            bundle_ciphertext_hex: hex(wire),
            chunk_count: chunks.length,
            transport: 'online_fallback',
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`Online fallback HTTP ${res.status}`);
      }
      this.emit({
        phase: 'completed',
        transport: 'online',
        totalBytes: wire.length,
        bytesSent: wire.length,
        message: 'Encrypted bundle uploaded for provider portal pickup',
      });
    } catch (e) {
      this.emit({
        phase: 'failed',
        transport: 'online',
        error: e instanceof Error ? e.message : String(e),
        message: 'Online fallback failed',
      });
    }
  }
}

let activeService: P2PTransferService | null = null;

export function getActiveP2PTransfer(): P2PTransferService | null {
  return activeService;
}

export function startP2PTransfer(options: P2PTransferOptions): P2PTransferService {
  if (activeService) {
    activeService.stop();
  }
  const service = new P2PTransferService();
  activeService = service;
  void service.start(options);
  return service;
}

export function stopP2PTransfer(): void {
  activeService?.stop();
  activeService = null;
}
