'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, Card, Group, Select, Stack, Text, Title, Tooltip, Table, ScrollArea } from '@mantine/core';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useCommandStore } from '@/lib/store';
import { buildPacket, driftPosition, nextSeq } from '@/lib/packets';
import type { OfflinePacket, PacketKind } from '@/lib/types';

const KIND_LABEL: Record<PacketKind, string> = { position: '位置', patrol: '巡视', assignment: '调派' };
const STATUS_META: Record<OfflinePacket['status'], { label: string; color: string }> = {
  pending: { label: '待补传', color: 'gray' },
  applied: { label: '已生效', color: 'teal' },
  archived: { label: '已留历史', color: 'blue' },
  blocked: { label: '已阻塞', color: 'orange' },
  conflict: { label: '待核对', color: 'red' },
  failed: { label: '失败', color: 'red' }
};

const fmtObserved = (iso?: string) => iso ? formatDistanceToNow(new Date(iso), { addSuffix: true, locale: zhCN }) : '—';

export function OfflineBackfillPanel() {
  const state = useCommandStore();
  const [assetId, setAssetId] = useState<string>('ship-01');
  const [kind, setKind] = useState<PacketKind>('position');

  const packets = state.packets;
  const groups = useMemo(() => ({
    pending: packets.filter((p) => p.status === 'pending'),
    conflict: packets.filter((p) => p.status === 'conflict'),
    blocked: packets.filter((p) => p.status === 'blocked'),
    failed: packets.filter((p) => p.status === 'failed'),
    history: packets.filter((p) => p.status === 'applied' || p.status === 'archived')
  }), [packets]);

  const recordOffline = () => {
    const asset = state.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const seq = nextSeq(state.packets, assetId);
    const observedAt = new Date(Date.now() - Math.floor(Math.random() * 20 + 2) * 60_000).toISOString();
    let payload: OfflinePacket['payload'];
    if (kind === 'position') {
      payload = driftPosition(asset.lat, asset.lng, +(Math.random() * 0.04 - 0.02).toFixed(4), +(Math.random() * 0.04 - 0.02).toFixed(4));
    } else if (kind === 'patrol') {
      const area = state.areas.find((a) => a.status !== 'closed') ?? state.areas[0];
      payload = { areaId: area.id, note: '离线巡视记录' };
    } else {
      const mission = state.missions.find((m) => m.status !== 'closed') ?? state.missions[0];
      payload = { missionId: mission.id, areaId: mission.areaId };
    }
    state.enqueuePacket(buildPacket({ asset, kind, seq, observedAt, payload }));
  };

  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={3}>离线补传 · 任务单合并</Title>
          <Text size="sm" c="dimmed">每包携带救援单位、业务序号与观测时刻；网络恢复后按当前有效版本合并，旧位置不覆盖新位置</Text>
        </div>
        <Group>
          <Tooltip label={state.offline ? '离线期间单位记录补传包' : '在线时也可模拟离线作业'}>
            <Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线作业中' : '网络在线'}</Badge>
          </Tooltip>
        </Group>
      </Group>

      {/* 操作行 */}
      <Group mt="md" align="flex-end">
        <Select label="救援单位" data={state.assets.map((a) => ({ value: a.id, label: a.name }))} value={assetId} onChange={(v) => v && setAssetId(v)} style={{ width: 160 }} />
        <Select label="包类型" data={[{ value: 'position', label: '位置' }, { value: 'patrol', label: '巡视' }, { value: 'assignment', label: '任务调派' }]} value={kind} onChange={(v) => v && setKind(v as PacketKind)} style={{ width: 140 }} />
        <Button variant="light" onClick={recordOffline}>记录离线包</Button>
        <Button onClick={state.reconcileAll} disabled={groups.pending.length === 0 && groups.failed.length === 0}>网络恢复 · 批量补传{groups.pending.length ? `（${groups.pending.length}）` : ''}</Button>
        <Button variant="outline" color="grape" onClick={state.seedDemoPackets}>一键生成演示包并补传</Button>
      </Group>

      {/* 待核对包 */}
      {groups.conflict.length > 0 && (
        <Stack mt="lg" gap="xs">
          <Group><Badge color="red">待核对包 {groups.conflict.length}</Badge><Text size="xs" c="dimmed">同一单位同一时刻出现两条位置，较新接收的已定当前值，以下包留待核对</Text></Group>
          {groups.conflict.map((p) => {
            const asset = state.assets.find((a) => a.id === p.assetId);
            return (
              <Card key={p.id} withBorder padding="sm" bg="red.0">
                <Group justify="space-between">
                  <div>
                    <Group gap="xs"><Badge color="red">{STATUS_META.conflict.label}</Badge><Text size="sm" fw={600}>{asset?.name ?? p.assetId}</Text><Text size="xs" c="dimmed">{KIND_LABEL[p.kind]} · 序号 {p.seq} · 观测 {fmtObserved(p.observedAt)}</Text></Group>
                    <Text size="xs" c="red" mt={4}>阻塞/待核对原因：{p.blockReason}</Text>
                  </div>
                  <Group>
                    <Button size="compact-xs" color="teal" onClick={() => state.resolveConflict(p.id, true)}>采纳为当前值</Button>
                    <Button size="compact-xs" variant="light" color="gray" onClick={() => state.resolveConflict(p.id, false)}>驳回留历史</Button>
                  </Group>
                </Group>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* 阻塞包 */}
      {groups.blocked.length > 0 && (
        <Stack mt="lg" gap="xs">
          <Group><Badge color="orange">阻塞包 {groups.blocked.length}</Badge><Text size="xs" c="dimmed">搜索区已关闭 / 单位已失联 / 任务单容量不足 —— 只留历史，不改当前调派</Text></Group>
          {groups.blocked.map((p) => {
            const asset = state.assets.find((a) => a.id === p.assetId);
            return (
              <Card key={p.id} withBorder padding="sm" bg="orange.0">
                <Group gap="xs"><Badge color="orange">{STATUS_META.blocked.label}</Badge><Text size="sm" fw={600}>{asset?.name ?? p.assetId}</Text><Text size="xs" c="dimmed">{KIND_LABEL[p.kind]} · 序号 {p.seq} · 观测 {fmtObserved(p.observedAt)}</Text></Group>
                <Text size="xs" c="orange" mt={4}>阻塞原因：{p.blockReason}</Text>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* 失败包 */}
      {groups.failed.length > 0 && (
        <Stack mt="lg" gap="xs">
          <Group><Badge color="red">失败包 {groups.failed.length}</Badge><Text size="xs" c="dimmed">原包已保留，可恢复后重试</Text></Group>
          {groups.failed.map((p) => {
            const asset = state.assets.find((a) => a.id === p.assetId);
            return (
              <Card key={p.id} withBorder padding="sm" bg="red.0">
                <Group justify="space-between">
                  <div>
                    <Group gap="xs"><Badge color="red">{STATUS_META.failed.label}</Badge><Text size="sm" fw={600}>{asset?.name ?? p.assetId}</Text><Text size="xs" c="dimmed">{KIND_LABEL[p.kind]} · 序号 {p.seq} · 第 {p.attempts} 次</Text></Group>
                    <Text size="xs" c="red" mt={4}>失败原因：{p.error}</Text>
                  </div>
                  <Button size="compact-xs" onClick={() => state.retryPacket(p.id)}>恢复原包并重试</Button>
                </Group>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* 待补传 */}
      {groups.pending.length > 0 && (
        <Stack mt="lg" gap="xs">
          <Group><Badge color="gray">待补传 {groups.pending.length}</Badge><Text size="xs" c="dimmed">网络恢复后按版本合并，旧位置不会覆盖新位置</Text></Group>
          {groups.pending.map((p) => {
            const asset = state.assets.find((a) => a.id === p.assetId);
            return (
              <Card key={p.id} withBorder padding="sm">
                <Group gap="xs"><Badge color="gray">{STATUS_META.pending.label}</Badge><Text size="sm" fw={600}>{asset?.name ?? p.assetId}</Text><Text size="xs" c="dimmed">{KIND_LABEL[p.kind]} · 序号 {p.seq} · 观测 {fmtObserved(p.observedAt)}</Text></Group>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* 当前有效位置 */}
      <Stack mt="lg" gap="xs">
        <Group><Badge color="teal">当前有效位置</Badge><Text size="xs" c="dimmed">按当前有效版本合并后的位置（旧包不覆盖）</Text></Group>
        <ScrollArea>
          <Table striped withTableBorder>
            <thead><tr><th>救援单位</th><th>类型</th><th>当前位置</th><th>有效版本</th><th>接收时刻</th></tr></thead>
            <tbody>
              {state.assets.map((asset) => {
                const stale = Date.now() - new Date(asset.lastSeen).getTime() > 10 * 60_000;
                return (
                  <tr key={asset.id}>
                    <td><Group gap="xs"><Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>{asset.status}</Badge>{asset.name}</Group></td>
                    <td>{asset.type}</td>
                    <td><Text size="xs" c={stale ? 'red' : undefined}>{asset.lat.toFixed(4)}, {asset.lng.toFixed(4)}{stale ? ' · 位置过期' : ''}</Text></td>
                    <td><Text size="xs">{asset.validSeq ? `序号 ${asset.validSeq} · 观测 ${fmtObserved(asset.validObservedAt)}` : '初始值（补传后按版本更新）'}</Text></td>
                    <td><Text size="xs" c="dimmed">{asset.validReceivedAt ? fmtObserved(asset.validReceivedAt) : '—'}</Text></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </ScrollArea>
      </Stack>

      {/* 历史包 */}
      {groups.history.length > 0 && (
        <Stack mt="lg" gap="xs">
          <Group><Badge color="blue">历史包 {groups.history.length}</Badge><Text size="xs" c="dimmed">已生效或仅留历史的补传包</Text></Group>
          {groups.history.slice(0, 12).map((p) => {
            const asset = state.assets.find((a) => a.id === p.assetId);
            const meta = STATUS_META[p.status];
            return (
              <Group key={p.id} gap="xs">
                <Badge color={meta.color}>{meta.label}</Badge>
                <Text size="xs">{asset?.name ?? p.assetId} · {KIND_LABEL[p.kind]} · 序号 {p.seq} · 观测 {fmtObserved(p.observedAt)}</Text>
                {p.blockReason && <Text size="xs" c="orange">· {p.blockReason}</Text>}
              </Group>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}
