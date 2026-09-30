'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AreaStatus, AssetStatus, EventLog, Mission, MissionStatus, OfflinePacket, RescueAsset, SearchArea } from './types';
import { reconcilePacket } from './merge';
import { buildPacket, driftPosition, nextSeq } from './packets';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** 类型安全地更新指定补传包（避免对象字面量中的 status 被推断为 string） */
const patchPacket = (packets: OfflinePacket[], id: string, patch: Partial<OfflinePacket>): OfflinePacket[] =>
  packets.map((p) => (p.id === id ? { ...p, ...patch } : p));

const initialAreas: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32 },
  { id: 'area-c', name: 'C区 · 东南部（已关闭）', bounds: [121.50, 30.55, 121.76, 30.78], status: 'closed', coverage: 15 }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: iso(now - 35_000) },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: iso(now - 7 * 60_000) },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: iso(now - 18 * 60_000) },
  { id: 'shore-01', name: '岸观-01', type: 'shore', status: 'ready', lat: 30.71, lng: 121.48, lastSeen: iso(now - 2 * 60_000) }
];
const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: iso(now - 6 * 60_000), capacity: 3 }
];
const initialEvents: EventLog[] = [
  { id: 'event-1', time: iso(now - 15 * 60_000), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: iso(now - 6 * 60_000), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  packets: OfflinePacket[];
  offline: boolean;
  lowBandwidth: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  /** 追加一个待补传的离线包（原包不可变） */
  enqueuePacket: (packet: OfflinePacket) => void;
  /** 补传单个包：网络恢复后按当前有效版本合并 */
  reconcileOne: (id: string) => void;
  /** 批量补传所有待处理包 */
  reconcileAll: () => void;
  /** 失败后恢复原包并重试 */
  retryPacket: (id: string) => void;
  /** 处理待核对包：adopt=采纳为当前值，否则驳回留历史 */
  resolveConflict: (id: string, adopt: boolean) => void;
  /** 一键生成覆盖各类场景的演示补传包并补传 */
  seedDemoPackets: () => void;
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => {
      /** 对单个包执行合并并提交结果（失败时原包保留、可重试） */
      const runReconcile = (state: CommandState, id: string): Partial<CommandState> => {
        const packet = state.packets.find((p) => p.id === id);
        if (!packet) return {};
        const receivedAt = packet.receivedAt ?? new Date().toISOString();

        // 演示用：首次补传模拟通道中断，原包保留；重试即成功
        if (packet.failOnce && packet.attempts === 0) {
          const attempts = packet.attempts + 1;
          return {
            packets: patchPacket(state.packets, id, { status: 'failed', attempts, receivedAt, error: '补传通道中断（模拟），原包已保留，可重试' }),
            events: [{ id: crypto.randomUUID(), time: receivedAt, actor: '补传合并', message: `补传包 ${packet.id} 失败：通道中断，原包已保留（第 ${attempts} 次）` }, ...state.events]
          };
        }

        const result = reconcilePacket({ areas: state.areas, assets: state.assets, missions: state.missions, packet: { ...packet, receivedAt }, now: receivedAt });
        let packets = patchPacket(state.packets, id, { status: result.status, blockReason: result.blockReason, error: result.error, attempts: packet.attempts + 1, receivedAt });
        // 同时刻冲突：被顶下的原当前包留待核对
        if (result.demotedPacketId) {
          packets = patchPacket(packets, result.demotedPacketId, { status: 'conflict', blockReason: '同一观测时刻存在两条位置，本包接收顺序较早，留待核对' });
        }
        return {
          areas: result.areas,
          assets: result.assets,
          missions: result.missions,
          packets,
          events: result.event ? [result.event, ...state.events] : state.events
        };
      };

      return {
        areas: initialAreas,
        assets: initialAssets,
        missions: initialMissions,
        events: initialEvents,
        packets: [],
        offline: false,
        lowBandwidth: false,
        setAreaStatus: (id, status) => set((state) => ({
          areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
        })),
        setAssetStatus: (id, status) => set((state) => ({
          assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, lastSeen: new Date().toISOString() } : asset),
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` }, ...state.events]
        })),
        setMissionStatus: (id, status) => set((state) => ({
          missions: state.missions.map((mission) => mission.id === id ? { ...mission, status, updatedAt: new Date().toISOString() } : mission),
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `任务 ${id} 状态改为 ${status}` }, ...state.events]
        })),
        dispatchMission: (input) => set((state) => {
          const mission: Mission = { id: crypto.randomUUID(), ...input, status: 'dispatched', updatedAt: new Date().toISOString(), capacity: 3 };
          return {
            missions: [mission, ...state.missions],
            assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
            events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `任务“${input.title}”已派发` }, ...state.events]
          };
        }),
        toggleOffline: () => set((state) => ({ offline: !state.offline })),
        toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),

        enqueuePacket: (packet) => set((state) => ({ packets: [...state.packets, packet] })),

        reconcileOne: (id) => set((state) => runReconcile(state, id)),

        reconcileAll: () => set((state) => {
          let next: CommandState = state;
          for (const p of state.packets) {
            if (p.status !== 'pending') continue;
            const patch = runReconcile(next, p.id);
            next = { ...next, ...patch } as CommandState;
          }
          return { areas: next.areas, assets: next.assets, missions: next.missions, packets: next.packets, events: next.events };
        }),

        retryPacket: (id) => set((state) => {
          const packet = state.packets.find((p) => p.id === id);
          if (!packet) return {};
          // 恢复原包：回到待处理，清除失败原因，保留已生效的数据
          const reset = { ...packet, status: 'pending' as const, error: undefined, blockReason: undefined };
          const cleared = { ...state, packets: state.packets.map((p) => p.id === id ? reset : p) };
          const patch = runReconcile(cleared, id);
          return {
            ...patch,
            events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '补传合并', message: `补传包 ${id} 已恢复原包并重试` }, ...(patch.events ?? state.events)]
          };
        }),

        resolveConflict: (id, adopt) => set((state) => {
          const packet = state.packets.find((p) => p.id === id);
          if (!packet || packet.status !== 'conflict') return {};
          const nowIso = new Date().toISOString();
          const asset = state.assets.find((a) => a.id === packet.assetId);
          if (!asset) return {};

          if (!adopt) {
            // 驳回：仅留历史，不改当前值
            return {
              packets: patchPacket(state.packets, id, { status: 'archived', blockReason: undefined }),
              events: [{ id: crypto.randomUUID(), time: nowIso, actor: '指挥员', message: `待核对包 ${packet.id} 已驳回，仅留历史` }, ...state.events]
            };
          }

          // 采纳：本包位置定为当前值，原当前包留待核对
          if (packet.kind !== 'position') {
            return {
              packets: patchPacket(state.packets, id, { status: 'applied', blockReason: undefined }),
              events: [{ id: crypto.randomUUID(), time: nowIso, actor: '指挥员', message: `待核对包 ${packet.id} 已采纳为当前调派` }, ...state.events]
            };
          }
          const p = packet.payload as { lat: number; lng: number };
          const demotedId = asset.validPacketId;
          const newAssets = state.assets.map((a) => a.id === asset.id
            ? { ...a, lat: p.lat, lng: p.lng, lastSeen: packet.observedAt, validPacketId: packet.id, validObservedAt: packet.observedAt, validSeq: packet.seq, validReceivedAt: nowIso }
            : a);
          let packets = patchPacket(state.packets, id, { status: 'applied', blockReason: undefined });
          if (demotedId) {
            packets = patchPacket(packets, demotedId, { status: 'conflict', blockReason: '同时刻位置被指挥员采纳的新包顶下，留待核对' });
          }
          return {
            assets: newAssets,
            packets,
            events: [{ id: crypto.randomUUID(), time: nowIso, actor: '指挥员', message: `待核对包 ${packet.id} 已采纳为单位 ${asset.name} 的当前有效位置` }, ...state.events]
          };
        }),

        seedDemoPackets: () => {
          const t = Date.now();
          const isoT = (ms: number) => new Date(ms).toISOString();
          set((state) => {
            const ship = state.assets.find((a) => a.id === 'ship-01')!;
            const heli = state.assets.find((a) => a.id === 'heli-02')!;
            const shore = state.assets.find((a) => a.id === 'shore-01')!;
            const drone = state.assets.find((a) => a.id === 'drone-03')!;
            const existing = state.packets;
            const seq = (assetId: string) => nextSeq(existing, assetId);
            const packets: OfflinePacket[] = [
              // 1. 旧位置（版本更旧 → 归档）
              buildPacket({ asset: ship, kind: 'position', seq: seq('ship-01'), observedAt: isoT(t - 60 * 60_000), payload: driftPosition(ship.lat, ship.lng, -0.02, 0.01) }),
              // 2. 较新位置
              buildPacket({ asset: ship, kind: 'position', seq: seq('ship-01'), observedAt: isoT(t - 10 * 60_000), payload: driftPosition(ship.lat, ship.lng, 0.01, -0.02) }),
              // 3. 同时刻冲突位置（接收更晚 → 定为当前，包2留待核对）
              buildPacket({ asset: ship, kind: 'position', seq: seq('ship-01'), observedAt: isoT(t - 10 * 60_000), payload: driftPosition(ship.lat, ship.lng, 0.03, 0.02) }),
              // 4. 直升机调派（容量内 → 生效）
              buildPacket({ asset: heli, kind: 'assignment', seq: seq('heli-02'), observedAt: isoT(t - 8 * 60_000), payload: { missionId: 'mission-1', areaId: 'area-a' } }),
              // 5. 岸观调派（容量不足 → 阻塞）
              buildPacket({ asset: shore, kind: 'assignment', seq: seq('shore-01'), observedAt: isoT(t - 7 * 60_000), payload: { missionId: 'mission-1', areaId: 'area-a' } }),
              // 6. 无人机调派（失联 → 阻塞）
              buildPacket({ asset: drone, kind: 'assignment', seq: seq('drone-03'), observedAt: isoT(t - 6 * 60_000), payload: { missionId: 'mission-1', areaId: 'area-a' } }),
              // 7. C区巡视（区域已关闭 → 阻塞）
              buildPacket({ asset: ship, kind: 'patrol', seq: seq('ship-01'), observedAt: isoT(t - 5 * 60_000), payload: { areaId: 'area-c', note: '东南部巡视' } }),
              // 8. 模拟补传中断（失败 → 可重试）
              buildPacket({ asset: ship, kind: 'position', seq: seq('ship-01'), observedAt: isoT(t - 4 * 60_000), payload: driftPosition(ship.lat, ship.lng, 0.005, -0.005), failOnce: true })
            ];
            return { packets: [...existing, ...packets] };
          });
          // 入袋后立即批量补传
          get().reconcileAll();
        }
      };
    },
    { name: 'maritime-command-v2' }
  )
);
