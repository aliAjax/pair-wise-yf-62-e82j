import type {
  BlockReason,
  EventLog,
  Mission,
  PacketKind,
  RescueAsset,
  SearchArea,
  SyncPacket,
} from './types';

/** 合并输入：当前快照 + 本批待补传包（不会修改入参） */
export interface MergeInput {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  packets: SyncPacket[];
}

export interface MergeResult {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  packets: SyncPacket[];
  events: EventLog[];
  appliedCount: number;
  reviewCount: number;
  historyCount: number;
}

export const REASON_LABEL: Record<BlockReason, string> = {
  area_closed: '搜索区已关闭',
  asset_offline: '单位已失联',
  capacity_full: '任务单容量不足',
  stale_version: '旧版本，已被更新序号覆盖',
  coverage_regression: '覆盖率倒退，禁止生效',
  duplicate_pending: '同一观测时刻存在两条位置，留待核对',
  rejected_review: '人工核对后判定不生效',
  apply_failed: '补传失败，等待重试',
};

export const PACKET_KIND_LABEL: Record<PacketKind, string> = {
  patrol: '巡视',
  position: '位置',
  dispatch: '任务调派',
};

const clone = <T>(value: T): T => structuredClone(value);

const addEvent = (events: EventLog[], actor: string, message: string): void => {
  events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, message });
};

const markHistory = (packet: SyncPacket, reason: BlockReason, note?: string): void => {
  packet.status = 'history_only';
  packet.reason = reason;
  packet.note = note ?? REASON_LABEL[reason];
};

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(key(item)) ?? [];
    list.push(item);
    map.set(key(item), list);
  }
  return map;
};

/** 序号更大（序号相同观测更晚、再相同接收更新）者为当前有效版本 */
const byVersion = (a: SyncPacket, b: SyncPacket): number =>
  b.seq - a.seq
  || new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime()
  || new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  || b.id.localeCompare(a.id);

/**
 * 离线补传合并：按“当前有效版本”收敛，而非最后到达覆盖。
 * 纯函数、对包的处理顺序不敏感（按 单位/类型/搜索区/序号/观测时刻 归并），可安全重试。
 */
export function mergeBackfill(input: MergeInput): MergeResult {
  const areas = clone(input.areas);
  const assets = clone(input.assets);
  const missions = clone(input.missions);
  const packets = clone(input.packets);
  const events: EventLog[] = [];
  const appliedAt = new Date().toISOString();

  const assetName = (id: string): string => assets.find((asset) => asset.id === id)?.name ?? id;
  const areaName = (id: string): string => areas.find((area) => area.id === id)?.name ?? id;

  let appliedCount = 0;
  let reviewCount = 0;
  let historyCount = 0;

  const finishHistory = (packet: SyncPacket, reason: BlockReason, note?: string): void => {
    markHistory(packet, reason, note);
    historyCount += 1;
  };
  const finishReview = (packet: SyncPacket, note: string): void => {
    packet.status = 'pending_review';
    packet.reason = 'duplicate_pending';
    packet.note = note;
    reviewCount += 1;
  };
  const finishApplied = (packet: SyncPacket, note?: string): void => {
    packet.status = 'applied';
    packet.reason = undefined;
    packet.appliedAt = appliedAt;
    packet.note = note;
    appliedCount += 1;
  };

  const queued = packets.filter((packet) => packet.status === 'queued');

  // 统一闸门：单位不存在或已失联 —— 任何业务的补传都只留历史，不改当前调派/位置/覆盖率
  for (const packet of queued) {
    const asset = assets.find((item) => item.id === packet.assetId);
    if (!asset) {
      finishHistory(packet, 'asset_offline', '找不到对应救援单位');
      continue;
    }
    if (asset.status === 'offline') {
      finishHistory(packet, 'asset_offline', `单位 ${asset.name} 已失联，${PACKET_KIND_LABEL[packet.kind]}补传仅留历史`);
    }
  }

  // —— 位置包：按单位归并，同观测时刻以“较新接收”定当前值，另一条留待核对 ——
  const positionGroups = groupBy(
    queued.filter((packet) => packet.kind === 'position' && packet.status === 'queued'),
    (packet) => packet.assetId,
  );
  for (const [assetId, list] of positionGroups) {
    const asset = assets.find((item) => item.id === assetId)!;

    // 同观测时刻分组：除“最新接收 + 最大序号”的一条外，其余留待核对
    for (const group of groupBy(list, (packet) => packet.observedAt).values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        || b.seq - a.seq
        || b.id.localeCompare(a.id),
      );
      const [winner, ...losers] = sorted;
      losers.forEach((packet) => finishReview(
        packet,
        `与包 ${winner.id} 同为 ${asset.name} 在 ${formatClock(packet.observedAt)} 的位置；${winner.id} 接收更新，本条留待人工核对`,
      ));
    }

    // 可生效候选中取当前有效版本（序号大者胜，相同取观测更晚），其余为旧版本
    const candidates = list.filter((packet) => packet.status === 'queued').sort(byVersion);
    const effective = candidates[0];
    for (const packet of list) {
      if (packet.status !== 'queued') continue;
      if (packet !== effective) {
        finishHistory(packet, 'stale_version', `业务序号 ${packet.seq} 已被序号 ${effective.seq}（当前有效版本）覆盖`);
      }
    }
    if (effective) {
      const { lat, lng } = effective.payload as { lat: number; lng: number };
      asset.lat = lat;
      asset.lng = lng;
      asset.observedAt = effective.observedAt;
      asset.lastSeen = appliedAt;
      asset.positionVersion = effective.seq;
      finishApplied(effective, `生效为 ${asset.name} 当前有效位置（序号 ${effective.seq}）`);
      addEvent(events, asset.name, `离线位置补传生效：序号 ${effective.seq}，观测于 ${formatClock(effective.observedAt)}`);
    }
  }

  // —— 巡视包：按搜索区归并，先在本批选出最高序号候选，再按覆盖率防倒退裁决 ——
  const patrolGroups = groupBy(
    queued.filter((packet) => packet.kind === 'patrol' && packet.status === 'queued'),
    (packet) => (packet.payload as { areaId: string }).areaId,
  );
  for (const [areaId, list] of patrolGroups) {
    const area = areas.find((item) => item.id === areaId);

    // 搜索区已关闭：本批巡视全部只留历史
    if (!area || area.status === 'closed') {
      list.forEach((packet) => finishHistory(packet, 'area_closed', `搜索区 ${area ? area.name : areaId} 已关闭，巡视仅留历史`));
      continue;
    }

    // 本批最高序号候选（与处理顺序无关）；低于已生效版本的整批判为旧版本
    const ordered = [...list].sort(byVersion);
    const candidate = ordered[0];
    for (const packet of list) {
      if (packet !== candidate) finishHistory(packet, 'stale_version', `巡视序号 ${packet.seq} 已被本批序号 ${candidate.seq} 覆盖`);
    }
    if (candidate.seq < area.coverageVersion) {
      finishHistory(candidate, 'stale_version', `巡视序号 ${candidate.seq} 低于已生效版本 ${area.coverageVersion}`);
      continue;
    }
    const coverage = (candidate.payload as { coverage: number }).coverage;
    if (coverage < area.coverage) {
      finishHistory(candidate, 'coverage_regression', `上报覆盖率 ${coverage}% 低于当前 ${area.coverage}%，禁止倒退`);
      continue;
    }
    area.coverage = coverage;
    area.coverageVersion = candidate.seq;
    finishApplied(candidate, `${area.name} 覆盖率更新为 ${coverage}%（序号 ${candidate.seq}）`);
    addEvent(events, assetName(candidate.assetId), `${area.name} 巡视补传生效：覆盖率 ${coverage}%`);
  }

  // —— 任务调派包：按单位归并到最新调派，修复“同单位挂两个搜索区” ——
  const dispatchGroups = groupBy(
    queued.filter((packet) => packet.kind === 'dispatch' && packet.status === 'queued'),
    (packet) => packet.assetId,
  );
  for (const [assetId, list] of dispatchGroups) {
    const asset = assets.find((item) => item.id === assetId)!;

    // 本批每个单位只有最高序号调派参与裁决，其余判旧版本（与到达顺序无关）
    const ordered = [...list].sort(byVersion);
    const candidate = ordered[0];
    for (const packet of list) {
      if (packet !== candidate) finishHistory(packet, 'stale_version', `调派序号 ${packet.seq} 已被本批序号 ${candidate.seq} 覆盖`);
    }

    if (asset.dispatchVersion !== undefined && candidate.seq < asset.dispatchVersion) {
      finishHistory(candidate, 'stale_version', `调派序号 ${candidate.seq} 低于已生效版本 ${asset.dispatchVersion}`);
      continue;
    }

    const payload = candidate.payload as { areaId: string; missionId: string; missionTitle: string };
    const area = areas.find((item) => item.id === payload.areaId);
    if (!area || area.status === 'closed') {
      finishHistory(candidate, 'area_closed', `目标搜索区 ${area ? area.name : payload.areaId} 已关闭，调派仅留历史`);
      continue;
    }

    let mission = findMissionOpen(missions, payload.missionId, payload.areaId);
    if (!mission) {
      mission = {
        id: payload.missionId,
        title: payload.missionTitle || `${area.name}离线任务`,
        areaId: payload.areaId,
        assetIds: [],
        status: 'dispatched',
        priority: 'normal',
        note: '由离线补传恢复的任务单',
        updatedAt: appliedAt,
        capacity: 8,
      };
      missions.unshift(mission);
    }

    // 容量不足：只留历史，不挂入任何区，避免悬挂在两个搜索区
    const alreadyIn = mission.assetIds.includes(asset.id);
    if (!alreadyIn && mission.assetIds.length >= mission.capacity) {
      finishHistory(candidate, 'capacity_full', `任务单“${mission.title}”容量 ${mission.capacity} 已满，${asset.name} 调派仅留历史`);
      continue;
    }

    // 生效：先从其它任务单摘除，保证同一单位只挂一个搜索区
    for (const other of missions) {
      if (other.id !== mission.id && other.assetIds.includes(asset.id)) {
        other.assetIds = other.assetIds.filter((id) => id !== asset.id);
      }
    }
    if (!alreadyIn) mission.assetIds.push(asset.id);
    mission.updatedAt = appliedAt;
    if (asset.status === 'ready') asset.status = 'assigned';
    asset.dispatchVersion = candidate.seq;
    finishApplied(candidate, `${asset.name} 调派至 ${area.name} / ${mission.title}（序号 ${candidate.seq}）`);
    addEvent(events, asset.name, `离线调派补传生效：进入 ${area.name} 任务单“${mission.title}”`);
  }

  // 异常兜底（理论上不应到达）
  for (const packet of packets) {
    if (packet.status === 'queued' || packet.status === 'applying') {
      finishHistory(packet, 'apply_failed', '补传未能处理，保留原包待重试');
    }
  }

  if (appliedCount > 0 || reviewCount > 0 || historyCount > 0) {
    addEvent(
      events,
      '补传合并',
      `本批 ${queued.length} 包：生效 ${appliedCount}，待核对 ${reviewCount}，仅留历史 ${historyCount}`,
    );
  }

  return { areas, assets, missions, packets, events, appliedCount, reviewCount, historyCount };
}

const findMissionOpen = (missions: Mission[], missionId: string, areaId: string): Mission | undefined =>
  missions.find((mission) => mission.id === missionId && mission.areaId === areaId && mission.status !== 'closed')
  ?? missions.find((mission) => mission.areaId === areaId && mission.status !== 'closed');

/** 人工核对：判定一条待核对位置是否生效（仍受失联/旧版本约束，已生效调派与覆盖率不受影响） */
export function resolveReview(
  input: MergeInput,
  packetId: string,
  decision: 'accept' | 'reject',
): MergeResult {
  const areas = clone(input.areas);
  const assets = clone(input.assets);
  const missions = clone(input.missions);
  const packets = clone(input.packets);
  const events: EventLog[] = [];
  const packet = packets.find((item) => item.id === packetId);

  if (!packet || packet.status !== 'pending_review' || packet.kind !== 'position') {
    return { areas, assets, missions, packets, events, appliedCount: 0, reviewCount: 0, historyCount: 0 };
  }

  const asset = assets.find((item) => item.id === packet.assetId);
  const reason =
    !asset ? '找不到对应救援单位'
    : asset.status === 'offline' ? `单位 ${asset.name} 已失联`
    : packet.seq < asset.positionVersion ? `业务序号 ${packet.seq} 低于当前有效版本 ${asset.positionVersion}`
    : undefined;

  if (decision === 'reject' || reason) {
    markHistory(
      packet,
      decision === 'reject' ? 'rejected_review' : 'stale_version',
      decision === 'reject' ? '人工核对后判定不生效，仅留历史' : reason,
    );
    addEvent(events, '值班员', `待核对位置包 ${packet.id} 未生效（${packet.note ?? reason ?? '人工驳回'}）`);
    return { areas, assets, missions, packets, events, appliedCount: 0, reviewCount: 0, historyCount: 1 };
  }

  const { lat, lng } = packet.payload as { lat: number; lng: number };
  asset!.lat = lat;
  asset!.lng = lng;
  asset!.observedAt = packet.observedAt;
  asset!.lastSeen = new Date().toISOString();
  asset!.positionVersion = packet.seq;
  packet.status = 'applied';
  packet.reason = undefined;
  packet.appliedAt = new Date().toISOString();
  packet.note = `人工核对后生效（序号 ${packet.seq}）`;

  // 原占位的当前值若与之同刻，则转入待核对，交指挥员二次确认，避免静默覆盖
  const displaced = packets.find(
    (item) => item.id !== packet.id
      && item.kind === 'position'
      && item.assetId === packet.assetId
      && item.status === 'applied'
      && item.observedAt === packet.observedAt,
  );
  if (displaced) {
    displaced.status = 'pending_review';
    displaced.reason = 'duplicate_pending';
    displaced.note = `人工改采包 ${packet.id}，原当前值转入待核对`;
    displaced.appliedAt = undefined;
  }

  addEvent(events, '值班员', `待核对位置包 ${packet.id} 经人工核对生效，${asset!.name} 位置已更新`);
  return { areas, assets, missions, packets, events, appliedCount: 1, reviewCount: displaced ? 1 : 0, historyCount: 0 };
}

const formatClock = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};
