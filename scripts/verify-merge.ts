import { mergeBackfill, resolveReview } from '../src/lib/merge';
import type { Mission, PacketKind, RescueAsset, SearchArea, SyncPacket } from '../src/lib/types';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (cond) { passed += 1; }
  else { failed += 1; console.error('  ✗ ' + msg); }
};

const iso = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const makeAreas = (): SearchArea[] => [
  { id: 'A', name: 'A区', bounds: [0, 0, 1, 1], status: 'active', coverage: 60, coverageVersion: 5 },
  { id: 'B', name: 'B区', bounds: [0, 0, 1, 1], status: 'planned', coverage: 10, coverageVersion: 1 },
  { id: 'C', name: 'C区', bounds: [0, 0, 1, 1], status: 'closed', coverage: 90, coverageVersion: 9 }
];
const makeAssets = (): RescueAsset[] => [
  { id: 's1', name: '海巡', type: 'ship', status: 'assigned', lat: 1, lng: 1, observedAt: iso(40), lastSeen: iso(2), positionVersion: 3 },
  { id: 'h2', name: '直升机', type: 'helicopter', status: 'ready', lat: 2, lng: 2, observedAt: iso(40), lastSeen: iso(2), positionVersion: 1 },
  { id: 'd3', name: '无人机', type: 'drone', status: 'offline', lat: 3, lng: 3, observedAt: iso(40), lastSeen: iso(30), positionVersion: 1 }
];
const makeMissions = (): Mission[] => [
  { id: 'm1', title: 'M1', areaId: 'A', assetIds: ['s1'], status: 'in_progress', priority: 'urgent', note: '', updatedAt: iso(5), capacity: 1 }
];
const pk = (id: string, assetId: string, kind: PacketKind, seq: number, observedMin: number, receivedMin: number, payload: SyncPacket['payload']): SyncPacket =>
  ({ id, assetId, kind, seq, observedAt: iso(observedMin), receivedAt: iso(receivedMin), payload, status: 'queued', attempts: 0 });

// 场景 1：版本合并 + 旧位置不能盖新位置 + 覆盖率不倒退
{
  console.log('场景1：版本合并 / 防倒退');
  const packets = [
    pk('p-old', 's1', 'position', 2, 30, 10, { lat: 9, lng: 9 }),           // 旧序号
    pk('p-new', 's1', 'position', 4, 5, 1, { lat: 1.5, lng: 1.5 }),          // 当前有效
    pk('cov-up', 's1', 'patrol', 6, 6, 2, { areaId: 'A', coverage: 72 }),   // 覆盖率提升
    pk('cov-down', 's1', 'patrol', 2, 3, 1, { areaId: 'B', coverage: 5 })    // 低于B区当前10，倒退拒绝
  ];
  const r = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets });
  const ship = r.assets.find((a) => a.id === 's1')!;
  assert(ship.lat === 1.5 && ship.lng === 1.5 && ship.positionVersion === 4, '新序号位置生效，旧位置不覆盖');
  assert(r.packets.find((p) => p.id === 'p-old')!.status === 'history_only', '旧位置仅留历史');
  assert(r.areas.find((a) => a.id === 'A')!.coverage === 72, '覆盖率提升到72');
  assert(r.areas.find((a) => a.id === 'B')!.coverage === 10, '倒退包所在B区覆盖率保持10不倒退');
  assert(r.packets.find((p) => p.id === 'cov-down')!.status === 'history_only', '覆盖率倒退包仅留历史');
  assert(r.packets.find((p) => p.id === 'cov-down')!.reason === 'coverage_regression', '倒退原因正确');
  assert(ship.observedAt === packets[1].observedAt, '生效观测时刻取自包');
}

// 场景 2：同单位同一观测时刻两条位置，较新接收定当前值，另一条待核对
{
  console.log('场景2：同刻位置冲突，新接收者生效');
  const t = iso(12);
  const packets = [
    { ...pk('dup-a', 'h2', 'position', 2, 12, 8, { lat: 2.1, lng: 2.1 }), observedAt: t },
    { ...pk('dup-b', 'h2', 'position', 2, 12, 2, { lat: 2.9, lng: 2.9 }), observedAt: t }
  ];
  const r = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets });
  const heli = r.assets.find((a) => a.id === 'h2')!;
  assert(heli.lat === 2.9, '较新接收(dup-b)定为当前值');
  assert(r.packets.find((p) => p.id === 'dup-a')!.status === 'pending_review', '较早接收者留待核对');
  assert(r.packets.find((p) => p.id === 'dup-a')!.reason === 'duplicate_pending', '待核对原因正确');
}

// 场景 3：搜索区已关闭 / 单位已失联
{
  console.log('场景3：关闭区与失联单位只留历史');
  const packets = [
    pk('closed-dispatch', 's1', 'dispatch', 9, 5, 1, { areaId: 'C', missionId: 'mc', missionTitle: 'X' }),
    pk('closed-patrol', 's1', 'patrol', 9, 5, 1, { areaId: 'C', coverage: 99 }),
    pk('offline-pos', 'd3', 'position', 2, 4, 1, { lat: 3.3, lng: 3.3 }),
    pk('offline-patrol', 'd3', 'patrol', 2, 4, 1, { areaId: 'B', coverage: 80 }),
    pk('offline-dispatch', 'd3', 'dispatch', 2, 4, 1, { areaId: 'B', missionId: 'mb', missionTitle: 'Y' })
  ];
  const r = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets });
  assert(r.packets.find((p) => p.id === 'closed-dispatch')!.reason === 'area_closed', '关闭区调派被阻塞');
  assert(r.packets.find((p) => p.id === 'closed-patrol')!.reason === 'area_closed', '关闭区巡视被阻塞');
  assert(r.packets.find((p) => p.id === 'offline-pos')!.reason === 'asset_offline', '失联单位位置只留历史');
  assert(r.packets.find((p) => p.id === 'offline-patrol')!.reason === 'asset_offline', '失联单位巡视只留历史');
  assert(r.packets.find((p) => p.id === 'offline-dispatch')!.reason === 'asset_offline', '失联单位调派只留历史');
  assert(r.areas.find((a) => a.id === 'B')!.coverage === 10, '失联单位巡视不提升覆盖率');
  const drone = r.assets.find((a) => a.id === 'd3')!;
  assert(drone.lat === 3 && drone.lng === 3, '失联单位当前位置不变');
  assert(r.missions.length === 1, '未为关闭区/失联单位创建任务单');
}

// 场景 4：容量不足阻塞，且单位不会同时挂在两个搜索区
{
  console.log('场景4：容量不足 + 单位唯一归属');
  const packets = [
    // m1 在 A 区容量1 且已含 s1；把在线的 h2 派往 m1 -> 容量不足
    pk('cap-full', 'h2', 'dispatch', 1, 5, 1, { areaId: 'A', missionId: 'm1', missionTitle: 'M1' }),
    // s1 调往 B 区新任务 -> 应从 A 区 m1 摘除，只挂 B
    pk('move', 's1', 'dispatch', 5, 4, 1, { areaId: 'B', missionId: 'm2', missionTitle: 'M2' })
  ];
  const r = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets });
  assert(r.packets.find((p) => p.id === 'cap-full')!.reason === 'capacity_full', '容量不足被阻塞');
  const m1 = r.missions.find((m) => m.id === 'm1')!;
  const m2 = r.missions.find((m) => m.id === 'm2')!;
  assert(!m1.assetIds.includes('h2'), '容量满时直升机未挂入m1');
  assert(Boolean(m2) && m2.assetIds.includes('s1'), '海巡挂入B区新任务m2');
  assert(!m1.assetIds.includes('s1'), '海巡已从A区m1摘除，不跨两个搜索区');
  const shipMemberships = r.missions.filter((m) => m.assetIds.includes('s1')).length;
  assert(shipMemberships === 1, '海巡仅属于一个任务单');
}

// 场景 5：已生效调派不倒退（旧调派包）
{
  console.log('场景5：已生效调派版本不倒退');
  const assets = makeAssets().map((a) => (a.id === 's1' ? { ...a, dispatchVersion: 5 } : a));
  const packets = [pk('stale-dispatch', 's1', 'dispatch', 4, 10, 1, { areaId: 'B', missionId: 'mx', missionTitle: 'X' })];
  const r = mergeBackfill({ areas: makeAreas(), assets, missions: makeMissions(), packets });
  assert(r.packets[0].status === 'history_only' && r.packets[0].reason === 'stale_version', '旧调派仅留历史');
  assert(r.missions.find((m) => m.id === 'm1')!.assetIds.includes('s1'), '当前调派未被旧包改动');
}

// 场景 6：补传失败原包保留，重试后生效；重试幂等
{
  console.log('场景6：失败保留 / 重试 / 幂等');
  const packets = [pk('ok', 's1', 'position', 4, 5, 1, { lat: 1.6, lng: 1.6 })];
  const base = { areas: makeAreas(), assets: makeAssets(), missions: makeMissions() };
  // 模拟 store：失败 -> failed，原包载荷保留
  const failedPackets = packets.map((p) => ({ ...p, status: 'failed' as const, attempts: 1, reason: 'apply_failed' as const }));
  assert(failedPackets[0].payload.lat === 1.6, '失败后原包完整保留');
  // 恢复为 queued 重试
  const retried = failedPackets.map((p) => ({ ...p, status: 'queued' as const }));
  const r1 = mergeBackfill({ ...base, packets: retried });
  assert(r1.assets.find((a) => a.id === 's1')!.lat === 1.6, '重试后生效');
  // 再次合并（已无 queued）不应改变结果，覆盖不倒退
  const r2 = mergeBackfill({ areas: r1.areas, assets: r1.assets, missions: r1.missions, packets: r1.packets });
  assert(r2.assets.find((a) => a.id === 's1')!.lat === 1.6, '重复合并不倒退');
  assert(r2.appliedCount === 0 && r2.events.length === 0, '无待补传时合并为空操作');
}

// 场景 7：处理顺序无关性（乱序入列结果一致）
{
  console.log('场景7：乱序包合并结果确定');
  const mk = (): SyncPacket[] => [
    pk('a', 's1', 'position', 2, 30, 9, { lat: 9, lng: 9 }),
    pk('b', 's1', 'position', 5, 3, 1, { lat: 5, lng: 5 }),
    pk('c', 's1', 'position', 4, 10, 4, { lat: 4, lng: 4 })
  ];
  const rAsc = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets: mk() });
  const shuffled = mk().reverse();
  const rDesc = mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets: shuffled });
  const sA = rAsc.assets.find((a) => a.id === 's1')!;
  const sD = rDesc.assets.find((a) => a.id === 's1')!;
  assert(sA.lat === sD.lat && sA.lat === 5 && sA.positionVersion === sD.positionVersion, '乱序不影响当前有效位置版本');
  assert(rAsc.appliedCount === rDesc.appliedCount && rAsc.appliedCount === 1, '乱序下位置生效数量一致');

  // 巡视乱序：高覆盖率低序号的包先到，也不得盖过更高序号（且高序号覆盖率更低时按防倒退落历史）
  const patrolMaker = (): SyncPacket[] => [
    pk('pa1', 's1', 'patrol', 7, 8, 4, { areaId: 'A', coverage: 80 }),
    pk('pa2', 's1', 'patrol', 8, 4, 1, { areaId: 'A', coverage: 75 })
  ];
  const runPatrol = (list: SyncPacket[]) => mergeBackfill({ areas: makeAreas(), assets: makeAssets(), missions: makeMissions(), packets: list });
  const p1 = runPatrol(patrolMaker());
  const p2 = runPatrol(patrolMaker().reverse());
  assert(p1.areas[0].coverage === p2.areas[0].coverage, `巡视乱序结果一致（${p1.areas[0].coverage}%）`);
  assert(p2.areas[0].coverage === 75 && p2.areas[0].coverageVersion === 8, '巡视按最高序号生效为75%');
  assert(p2.packets.find((x) => x.id === 'pa1')!.reason === 'stale_version', '低序号巡视落旧版本历史');

  // 调派乱序：同一单位两条调派，无论到达顺序都只执行最高序号那条
  const dispatchMaker = (): SyncPacket[] => [
    pk('da-low', 's1', 'dispatch', 6, 9, 5, { areaId: 'B', missionId: 'mB', missionTitle: 'B任务' }),
    pk('da-high', 's1', 'dispatch', 7, 3, 1, { areaId: 'A', missionId: 'mA-new', missionTitle: 'A区新任务' })
  ];
  const runDispatch = (list: SyncPacket[]) => mergeBackfill({ areas: makeAreas(), assets: makeAssets().map((a) => (a.id === 's1' ? { ...a, dispatchVersion: 5 } : a)), missions: makeMissions(), packets: list });
  const d1 = runDispatch(dispatchMaker());
  const d2 = runDispatch(dispatchMaker().reverse());
  const memberships = (r: typeof d1) => r.missions.filter((m) => m.assetIds.includes('s1')).map((m) => m.areaId).join(',');
  assert(memberships(d1) === memberships(d2) && memberships(d2) === 'A', '调派乱序结果一致，仅执行最高序号（A区）');
  assert(d2.packets.find((x) => x.id === 'da-low')!.status === 'history_only', '低序号调派落历史');
}

// 场景 8：人工核对——采信/驳回，且驳回/旧版本不生效
{
  console.log('场景8：人工核对 采信/驳回');
  const t = iso(12);
  const packets = [
    { ...pk('win', 'h2', 'position', 2, 12, 2, { lat: 2.9, lng: 2.9 }), observedAt: t, status: 'applied' as const, appliedAt: iso(1) },
    { ...pk('lose', 'h2', 'position', 2, 12, 8, { lat: 2.1, lng: 2.1 }), observedAt: t, status: 'pending_review' as const }
  ];
  const base = { areas: makeAreas(), assets: makeAssets().map((a) => (a.id === 'h2' ? { ...a, lat: 2.9, lng: 2.9, positionVersion: 2 } : a)), missions: makeMissions(), packets };
  // 驳回
  const rejected = resolveReview(base, 'lose', 'reject');
  assert(rejected.packets.find((p) => p.id === 'lose')!.status === 'history_only', '驳回后仅留历史');
  assert(rejected.assets.find((a) => a.id === 'h2')!.lat === 2.9, '驳回不改变当前位置');
  // 采信
  const accepted = resolveReview(base, 'lose', 'accept');
  assert(accepted.packets.find((p) => p.id === 'lose')!.status === 'applied', '采信后生效');
  assert(accepted.assets.find((a) => a.id === 'h2')!.lat === 2.1, '采信后位置更新');
  assert(accepted.packets.find((p) => p.id === 'win')!.status === 'pending_review', '原当前值转入待核对');
}

console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
