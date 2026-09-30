import type { EventLog, Mission, OfflinePacket, RescueAsset, SearchArea } from './types';

export interface ReconcileResult {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  status: OfflinePacket['status'];
  blockReason?: string;
  error?: string;
  event?: EventLog;
  /** 同时刻位置冲突时，被新包顶下、留待核对的原当前包 id */
  demotedPacketId?: string;
}

const newerVersion = (candidateObservedAt: string, candidateSeq: number, baseObservedAt?: string, baseSeq?: number): boolean => {
  if (!baseObservedAt) return true;
  const ct = Date.parse(candidateObservedAt).valueOf();
  const bt = Date.parse(baseObservedAt).valueOf();
  if (ct !== bt) return ct > bt;
  return candidateSeq > (baseSeq ?? 0);
};

const sameMoment = (a?: string, b?: string): boolean => {
  if (!a || !b) return false;
  return Date.parse(a).valueOf() === Date.parse(b).valueOf();
};

/**
 * 离线补传合并（纯函数）。
 * 按“当前有效版本”合并：版本更新（观测时刻更晚，或同时刻序号更大）的包才写入当前值；
 * 旧版本只留历史。搜索区已关闭、单位已失联或任务单容量不足时只留历史、不改当前调派。
 * 已生效的任务与覆盖率不会倒退。
 */
export function reconcilePacket(input: {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  packet: OfflinePacket;
  now: string;
}): ReconcileResult {
  const { areas, assets, missions, packet, now } = input;
  const eventBase = { id: crypto.randomUUID(), time: now, actor: '补传合并' };

  try {
    const asset = assets.find((a) => a.id === packet.assetId);
    if (!asset) {
      return { areas, assets, missions, status: 'failed', error: `未找到救援单位 ${packet.assetId}`, event: { ...eventBase, message: `补传包 ${packet.id} 失败：未找到单位` } };
    }

    if (packet.kind === 'position') {
      const p = packet.payload as { lat: number; lng: number };
      const differentPos = asset.lat !== p.lat || asset.lng !== p.lng;

      // 同一单位同一时刻出现两条位置 → 较新接收的定当前值，另一条留待核对
      if (sameMoment(asset.validObservedAt, packet.observedAt) && differentPos && asset.validPacketId) {
        const currentReceived = asset.validReceivedAt ?? '';
        const packetReceived = packet.receivedAt ?? now;
        if (packetReceived >= currentReceived) {
          const demotedPacketId = asset.validPacketId;
          const newAssets = assets.map((a) => a.id === asset.id
            ? { ...a, lat: p.lat, lng: p.lng, lastSeen: packet.observedAt, validPacketId: packet.id, validObservedAt: packet.observedAt, validSeq: packet.seq, validReceivedAt: packetReceived }
            : a);
          return {
            areas, assets: newAssets, missions, status: 'applied', demotedPacketId,
            event: { ...eventBase, message: `单位 ${asset.name} 同时刻位置冲突，较新接收包 ${packet.id} 定为当前值，原包 ${demotedPacketId} 留待核对` }
          };
        }
        return {
          areas, assets, missions, status: 'conflict',
          blockReason: '同一观测时刻存在两条位置，接收顺序较晚的包定为当前值，本包留待核对',
          event: { ...eventBase, message: `单位 ${asset.name} 同时刻位置冲突，包 ${packet.id} 留待核对` }
        };
      }

      if (newerVersion(packet.observedAt, packet.seq, asset.validObservedAt, asset.validSeq)) {
        const newAssets = assets.map((a) => a.id === asset.id
          ? { ...a, lat: p.lat, lng: p.lng, lastSeen: packet.observedAt, validPacketId: packet.id, validObservedAt: packet.observedAt, validSeq: packet.seq, validReceivedAt: packet.receivedAt ?? now }
          : a);
        return {
          areas, assets: newAssets, missions, status: 'applied',
          event: { ...eventBase, message: `单位 ${asset.name} 位置按版本合并为当前值（观测 ${packet.observedAt}，业务序号 ${packet.seq}）` }
        };
      }

      // 版本更旧 → 只留历史，不覆盖当前值
      return {
        areas, assets, missions, status: 'archived',
        event: { ...eventBase, message: `单位 ${asset.name} 位置包版本更旧，仅留历史，不覆盖当前值` }
      };
    }

    if (packet.kind === 'patrol') {
      const p = packet.payload as { areaId: string; note: string };
      const target = areas.find((a) => a.id === p.areaId);
      if (!target) {
        return { areas, assets, missions, status: 'failed', error: `未找到搜索区 ${p.areaId}`, event: { ...eventBase, message: '巡视包失败：未找到搜索区' } };
      }
      if (target.status === 'closed') {
        return {
          areas, assets, missions, status: 'blocked', blockReason: '搜索区已关闭，巡视补传只留历史，不改当前调派',
          event: { ...eventBase, message: `单位 ${asset.name} 巡视 ${target.name} 被阻塞：搜索区已关闭` }
        };
      }
      // 巡视提升覆盖率（单调不减，绝不倒退）
      const bumped = Math.min(100, target.coverage + 4);
      const newCoverage = Math.max(target.coverage, bumped);
      const newAreas = areas.map((a) => a.id === target.id ? { ...a, coverage: newCoverage } : a);
      return {
        areas: newAreas, assets, missions, status: 'applied',
        event: { ...eventBase, message: `单位 ${asset.name} 巡视 ${target.name}（${p.note || '例行巡视'}），覆盖率维持/提升至 ${newCoverage}%` }
      };
    }

    if (packet.kind === 'assignment') {
      const p = packet.payload as { missionId: string; areaId: string };
      const target = missions.find((m) => m.id === p.missionId);
      if (!target) {
        return { areas, assets, missions, status: 'failed', error: `未找到任务单 ${p.missionId}`, event: { ...eventBase, message: '调派包失败：未找到任务单' } };
      }
      const targetArea = areas.find((a) => a.id === target.areaId || a.id === p.areaId);
      if (targetArea?.status === 'closed') {
        return {
          areas, assets, missions, status: 'blocked', blockReason: '搜索区已关闭，调派补传只留历史，不改当前调派',
          event: { ...eventBase, message: `单位 ${asset.name} 调派 ${target.title} 被阻塞：搜索区已关闭` }
        };
      }
      if (asset.status === 'offline') {
        return {
          areas, assets, missions, status: 'blocked', blockReason: '单位已失联，调派补传只留历史，不改当前调派',
          event: { ...eventBase, message: `单位 ${asset.name} 调派 ${target.title} 被阻塞：单位已失联` }
        };
      }
      if (target.assetIds.length >= target.capacity) {
        return {
          areas, assets, missions, status: 'blocked', blockReason: '任务单容量不足，调派补传只留历史，不改当前调派',
          event: { ...eventBase, message: `单位 ${asset.name} 调派 ${target.title} 被阻塞：任务单容量不足（${target.assetIds.length}/${target.capacity}）` }
        };
      }
      // 已在本任务单 → 幂等生效
      if (target.assetIds.includes(asset.id)) {
        return {
          areas, assets, missions, status: 'applied',
          event: { ...eventBase, message: `单位 ${asset.name} 已在任务 ${target.title} 中，补传幂等生效` }
        };
      }
      // 同时挂在另一个未关闭任务单 → 冲突，不允许一个单位挂两个搜索区
      const otherMission = missions.find((m) => m.id !== target.id && m.assetIds.includes(asset.id) && m.status !== 'closed');
      if (otherMission) {
        return {
          areas, assets, missions, status: 'conflict',
          blockReason: `单位已挂在任务单 ${otherMission.title}，不能同时挂两个搜索区`,
          event: { ...eventBase, message: `单位 ${asset.name} 同时挂在两个搜索区，调派补传留待核对` }
        };
      }
      // 生效：加入任务单并置为已调派（只增不减，已生效任务不倒退）
      const newMissions = missions.map((m) => m.id === target.id
        ? { ...m, assetIds: [...m.assetIds, asset.id], updatedAt: now }
        : m);
      const newAssets = assets.map((a) => a.id === asset.id ? { ...a, status: 'assigned' as const } : a);
      return {
        areas, assets: newAssets, missions: newMissions, status: 'applied',
        event: { ...eventBase, message: `单位 ${asset.name} 调派补传生效，加入任务 ${target.title}（${target.assetIds.length + 1}/${target.capacity}）` }
      };
    }

    return { areas, assets, missions, status: 'failed', error: '未知包类型', event: { ...eventBase, message: '补传包失败：未知类型' } };
  } catch (e) {
    return { areas, assets, missions, status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
