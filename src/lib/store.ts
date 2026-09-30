'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AreaStatus, AssetStatus, EventLog, Mission, MissionStatus, RescueAsset, SearchArea, SyncPacket } from './types';
import { mergeBackfill, resolveReview } from './merge';

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

const initialAreas: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68, coverageVersion: 5 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32, coverageVersion: 2 },
  { id: 'area-c', name: 'C区 · 东岸浅滩', bounds: [121.94, 30.60, 122.12, 30.76], status: 'closed', coverage: 95, coverageVersion: 8 }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, observedAt: ago(36), lastSeen: ago(1), positionVersion: 10, dispatchVersion: 4 },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, observedAt: ago(9), lastSeen: ago(7), positionVersion: 3 },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, observedAt: ago(20), lastSeen: ago(18), positionVersion: 7, dispatchVersion: 2 }
];
const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: ago(6), capacity: 2 }
];
const initialEvents: EventLog[] = [
  { id: 'event-1', time: ago(15), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: ago(6), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

// 断链期间各单位缓存、链路恢复后到达的补传包：带救援单位、业务序号与观测时刻
const queued = (
  id: string,
  assetId: string,
  kind: SyncPacket['kind'],
  seq: number,
  observedMin: number,
  receivedMin: number,
  payload: SyncPacket['payload'],
): SyncPacket => ({ id, assetId, kind, seq, observedAt: ago(observedMin), receivedAt: ago(receivedMin), payload, status: 'queued', attempts: 0 });

const initialPackets: SyncPacket[] = [
  // 海巡071：旧位置版本、新位置版本；巡视覆盖率提升与“倒退包”；指向已关闭区的调派
  queued('pk-1', 'ship-01', 'position', 9, 31, 12, { lat: 30.77, lng: 121.58 }),
  queued('pk-2', 'ship-01', 'position', 11, 14, 6, { lat: 30.81, lng: 121.62 }),
  queued('pk-3', 'ship-01', 'patrol', 6, 26, 10, { areaId: 'area-a', coverage: 74 }),
  queued('pk-4', 'ship-01', 'patrol', 3, 8, 4, { areaId: 'area-b', coverage: 12 }),
  queued('pk-5', 'ship-01', 'dispatch', 5, 22, 9, { areaId: 'area-c', missionId: 'mission-3', missionTitle: 'C区浅滩复查' }),
  // 救助B-712：同单位同一观测时刻两条位置（序号同为4），较新接收者定当前值；调派撞上容量已满的任务单
  queued('pk-6', 'heli-02', 'position', 4, 11, 5.5, { lat: 30.84, lng: 121.76 }),
  queued('pk-7', 'heli-02', 'position', 4, 11, 2, { lat: 30.86, lng: 121.78 }),
  queued('pk-8', 'heli-02', 'dispatch', 1, 10, 3, { areaId: 'area-a', missionId: 'mission-1', missionTitle: 'A区扇形搜索' }),
  // 无人机D-9：单位已失联，巡视/位置/调派只留历史；恢复在线后可重新补传
  queued('pk-9', 'drone-03', 'position', 8, 6, 1.5, { lat: 30.71, lng: 121.64 }),
  queued('pk-10', 'drone-03', 'patrol', 9, 7, 1.2, { areaId: 'area-b', coverage: 45 }),
  queued('pk-11', 'drone-03', 'dispatch', 3, 6.5, 1, { areaId: 'area-b', missionId: 'mission-4', missionTitle: 'B区北漂移搜索' })
];

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  packets: SyncPacket[];
  offline: boolean;
  lowBandwidth: boolean;
  /** 演练开关：让下一次补传链路失败，验证原包保留与重试 */
  failNextSync: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string; capacity: number }) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  toggleFailNextSync: () => void;
  flushBackfill: () => void;
  retryPacket: (id: string) => void;
  retryFailedPackets: () => void;
  resolveReviewPacket: (id: string, decision: 'accept' | 'reject') => void;
}

type Snapshot = Pick<CommandState, 'areas' | 'assets' | 'missions' | 'packets'>;

/** 执行一次补传：若演练失败则整批保留为 failed（原子、不落半成品），否则按版本合并 */
function runFlush(state: Snapshot & { failNextSync: boolean; events: EventLog[] }) {
  const hasQueued = state.packets.some((packet) => packet.status === 'queued');
  if (!hasQueued) return {};

  if (state.failNextSync) {
    return {
      failNextSync: false,
      packets: state.packets.map((packet) => packet.status === 'queued'
        ? { ...packet, status: 'failed' as const, attempts: packet.attempts + 1, reason: 'apply_failed' as const, note: '补传链路失败，原包已保留，恢复后可重试' }
        : packet),
      events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '补传通道', message: '补传失败：本批包已原样保留，可恢复后重试' }, ...state.events]
    };
  }

  const result = mergeBackfill({ areas: state.areas, assets: state.assets, missions: state.missions, packets: state.packets });
  return {
    areas: result.areas,
    assets: result.assets,
    missions: result.missions,
    packets: result.packets,
    events: [...result.events, ...state.events]
  };
}

const requeueByReason = (packets: SyncPacket[], reason: SyncPacket['reason'], predicate: (packet: SyncPacket) => boolean): SyncPacket[] =>
  packets.map((packet) => packet.status === 'history_only' && packet.reason === reason && predicate(packet)
    ? { ...packet, status: 'queued' as const, reason: undefined, note: undefined }
    : packet);

export const useCommandStore = create<CommandState>()(
  persist(
    (set) => ({
      areas: initialAreas,
      assets: initialAssets,
      missions: initialMissions,
      events: initialEvents,
      packets: initialPackets,
      offline: false,
      lowBandwidth: false,
      failNextSync: false,
      setAreaStatus: (id, status) => set((state) => {
        // 重开搜索区时，此前因“区已关闭”只留历史的包重新进入补传
        const reopened = status !== 'closed';
        const packets = reopened
          ? requeueByReason(state.packets, 'area_closed', (packet) => {
              const payload = packet.payload as { areaId?: string };
              return payload.areaId === id;
            })
          : state.packets;
        const next = {
          ...state,
          areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
          packets,
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
        };
        return reopened ? { ...next, ...runFlush(next) } : next;
      }),
      setAssetStatus: (id, status) => set((state) => {
        const recovered = state.assets.find((asset) => asset.id === id)?.status === 'offline' && status !== 'offline';
        // 失联单位恢复在线：其因“单位失联”只留历史的包重新补传
        const packets = recovered
          ? requeueByReason(state.packets, 'asset_offline', (packet) => packet.assetId === id)
          : state.packets;
        const next = {
          ...state,
          assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, lastSeen: new Date().toISOString() } : asset),
          packets,
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` }, ...state.events]
        };
        return recovered ? { ...next, ...runFlush(next) } : next;
      }),
      setMissionStatus: (id, status) => set((state) => ({
        missions: state.missions.map((mission) => mission.id === id ? { ...mission, status, updatedAt: new Date().toISOString() } : mission),
        events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `任务 ${id} 状态改为 ${status}` }, ...state.events]
      })),
      dispatchMission: (input) => set((state) => {
        const mission: Mission = { id: crypto.randomUUID(), title: input.title, areaId: input.areaId, assetIds: input.assetIds, status: 'dispatched', priority: input.priority, note: input.note, updatedAt: new Date().toISOString(), capacity: input.capacity };
        return {
          missions: [mission, ...state.missions],
          assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
          events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `任务“${input.title}”已派发` }, ...state.events]
        };
      }),
      toggleOffline: () => set((state) => {
        // 模拟离线 -> 网络恢复：立即触发补传合并
        if (state.offline) {
          const next = { ...state, offline: false };
          return { ...next, ...runFlush(next) };
        }
        return { offline: true };
      }),
      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
      toggleFailNextSync: () => set((state) => ({ failNextSync: !state.failNextSync })),
      flushBackfill: () => set((state) => ({ offline: false, ...runFlush(state) })),
      retryPacket: (id) => set((state) => {
        const next = {
          ...state,
          packets: state.packets.map((packet) => packet.id === id && packet.status === 'failed'
            ? { ...packet, status: 'queued' as const, reason: undefined, note: '恢复原包后重新补传' }
            : packet)
        };
        return { ...next, ...runFlush(next) };
      }),
      retryFailedPackets: () => set((state) => {
        if (!state.packets.some((packet) => packet.status === 'failed')) return {};
        const next = {
          ...state,
          packets: state.packets.map((packet) => packet.status === 'failed'
            ? { ...packet, status: 'queued' as const, reason: undefined, note: '恢复原包后重新补传' }
            : packet)
        };
        return { ...next, ...runFlush(next) };
      }),
      resolveReviewPacket: (id, decision) => set((state) => {
        const result = resolveReview({ areas: state.areas, assets: state.assets, missions: state.missions, packets: state.packets }, id, decision);
        return {
          areas: result.areas,
          assets: result.assets,
          missions: result.missions,
          packets: result.packets,
          events: [...result.events, ...state.events]
        };
      })
    }),
    { name: 'maritime-command-v2' }
  )
);
