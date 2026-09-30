export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
  /** 已生效巡视包的业务序号（当前有效版本），用于离线合并防倒退 */
  coverageVersion: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  /** 观测时刻（位置实际发生时间），离线补传以它判断新旧，而非接收顺序 */
  observedAt: string;
  /** 最后接收（在线/补传生效）时刻，用于页面“过期位置”判定 */
  lastSeen: string;
  /** 已生效位置包的业务序号（当前有效版本） */
  positionVersion: number;
  /** 已生效任务调派包的业务序号（当前有效版本） */
  dispatchVersion?: number;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  updatedAt: string;
  /** 任务单容量：补传统计时单位挂入但容量不足时，只留历史不改当前调派 */
  capacity: number;
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}

/** 补传业务类型：巡视（覆盖率）、位置、任务调派 */
export type PacketKind = 'patrol' | 'position' | 'dispatch';

/**
 * 补传包生命周期：
 * - queued 待补传 / applying 补传中 / applied 已生效（不可倒退）
 * - pending_review 同单位同一观测时刻出现两条位置，落败方留待核对
 * - history_only 关闭区、失联单位、容量不足、旧版本等，只留历史不改当前
 * - failed 补传失败，原包保留可重试
 */
export type PacketStatus = 'queued' | 'applying' | 'applied' | 'pending_review' | 'history_only' | 'failed';

/** 阻塞 / 只留历史的原因 */
export type BlockReason =
  | 'area_closed'
  | 'asset_offline'
  | 'capacity_full'
  | 'stale_version'
  | 'coverage_regression'
  | 'duplicate_pending'
  | 'rejected_review'
  | 'apply_failed';

export interface PositionPayload {
  lat: number;
  lng: number;
}

export interface PatrolPayload {
  /** 该搜索区观测到的累计覆盖率百分比 */
  coverage: number;
  areaId: string;
}

export interface DispatchPayload {
  areaId: string;
  missionId: string;
  missionTitle: string;
}

export type PacketPayload = PositionPayload | PatrolPayload | DispatchPayload;

export interface SyncPacket {
  id: string;
  /** 救援单位 */
  assetId: string;
  kind: PacketKind;
  /** 业务序号：同一单位同一业务上单调递增，是“当前有效版本”的判定依据 */
  seq: number;
  /** 观测时刻：位置实际发生的时间，用于同刻冲突与新旧排序 */
  observedAt: string;
  /** 接收时刻（网络恢复后入列）：同单位同一观测时刻两条位置时，较新接收者定当前值 */
  receivedAt: string;
  payload: PacketPayload;
  status: PacketStatus;
  /** history_only / pending_review / failed 的原因 */
  reason?: BlockReason;
  /** 处理备注（含被哪条包覆盖、阻塞明细等） */
  note?: string;
  /** 补传尝试次数，失败重试时累加，原包始终保留 */
  attempts: number;
  /** 已生效后记录，便于追溯与单调判定 */
  appliedAt?: string;
}
