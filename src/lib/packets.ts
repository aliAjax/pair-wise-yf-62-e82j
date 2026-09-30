import type { OfflinePacket, PacketKind, PacketPayload, RescueAsset } from './types';

/** 取某单位下一个业务序号（已有包的最大序号 +1） */
export function nextSeq(packets: OfflinePacket[], assetId: string): number {
  return packets.filter((p) => p.assetId === assetId).reduce((m, p) => Math.max(m, p.seq), 0) + 1;
}

/** 构造一个离线补传包（原包不可变，失败后仍可据此重试） */
export function buildPacket(input: {
  asset: RescueAsset;
  kind: PacketKind;
  seq: number;
  observedAt: string;
  payload: PacketPayload;
  receivedAt?: string | null;
  failOnce?: boolean;
}): OfflinePacket {
  return {
    id: `pkt-${crypto.randomUUID()}`,
    assetId: input.asset.id,
    kind: input.kind,
    seq: input.seq,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt ?? null,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    failOnce: input.failOnce
  };
}

/** 位置漂移：在当前位置基础上做小范围随机游走 */
export function driftPosition(lat: number, lng: number, dLat: number, dLng: number): { lat: number; lng: number } {
  return { lat: +(lat + dLat).toFixed(4), lng: +(lng + dLng).toFixed(4) };
}
