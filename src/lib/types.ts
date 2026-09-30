export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  lastSeen: string;
  /** 当前有效位置的来源包（由补传合并写入）；无则为初始值 */
  validPacketId?: string;
  validObservedAt?: string;
  validSeq?: number;
  validReceivedAt?: string;
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
  /** 任务单容量：最多同时容纳的救援单位数 */
  capacity: number;
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}

/** 补传包类型：巡视 / 位置 / 任务调派 */
export type PacketKind = 'position' | 'patrol' | 'assignment';

/**
 * 补传包状态：
 * - pending    待网络恢复后补传
 * - applied    已生效（写入当前值 / 当前调派）
 * - archived   版本更旧或被驳回，仅留历史，不改当前值
 * - blocked    阻塞：只留历史，不改当前调派
 * - conflict   待核对：同一单位同一时刻出现两条位置，或单位同时挂在两个搜索区
 * - failed     补传失败，原包保留，可重试
 */
export type PacketStatus = 'pending' | 'applied' | 'archived' | 'blocked' | 'conflict' | 'failed';

export interface PositionPayload {
  lat: number;
  lng: number;
}

export interface PatrolPayload {
  areaId: string;
  note: string;
}

export interface AssignmentPayload {
  missionId: string;
  areaId: string;
}

export type PacketPayload = PositionPayload | PatrolPayload | AssignmentPayload;

/**
 * 离线补传包。每包携带救援单位、业务序号与观测时刻；
 * 网络恢复后按“当前有效版本”合并，而非按到达顺序覆盖。
 */
export interface OfflinePacket {
  id: string;
  /** 救援单位 */
  assetId: string;
  /** 业务序号（同一单位内单调递增的版本号） */
  seq: number;
  kind: PacketKind;
  /** 观测时刻 */
  observedAt: string;
  /** 接收时刻（返航补传到指挥端的时间，用于同时刻冲突的先后判定） */
  receivedAt: string | null;
  payload: PacketPayload;
  status: PacketStatus;
  /** 阻塞原因（搜索区已关闭 / 单位已失联 / 任务单容量不足） */
  blockReason?: string;
  /** 失败原因 */
  error?: string;
  attempts: number;
  /** 演示用：首次补传模拟通道中断，重试即成功 */
  failOnce?: boolean;
}
