'use client';

import { Badge, Button, Card, Group, SimpleGrid, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { ReactNode } from 'react';
import { useCommandStore } from '@/lib/store';
import { PACKET_KIND_LABEL, REASON_LABEL } from '@/lib/merge';
import type { DispatchPayload, PacketStatus, PatrolPayload, PositionPayload, RescueAsset, SyncPacket } from '@/lib/types';

const STATUS_META: Record<PacketStatus, { label: string; color: string }> = {
  queued: { label: '待补传', color: 'yellow' },
  applying: { label: '补传中', color: 'blue' },
  applied: { label: '已生效', color: 'teal' },
  pending_review: { label: '待核对', color: 'orange' },
  history_only: { label: '仅留历史', color: 'gray' },
  failed: { label: '补传失败', color: 'red' }
};

const clock = (iso?: string): string => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--');

export function BackfillPanel() {
  const {
    assets, areas, packets, offline, failNextSync,
    flushBackfill, toggleOffline, toggleFailNextSync,
    retryPacket, retryFailedPackets, resolveReviewPacket
  } = useCommandStore();

  const assetName = (id: string): string => assets.find((asset) => asset.id === id)?.name ?? id;
  const areaName = (id: string): string => areas.find((area) => area.id === id)?.name ?? id;

  const payloadText = (packet: SyncPacket): string => {
    if (packet.kind === 'position') {
      const { lat, lng } = packet.payload as PositionPayload;
      return `坐标 ${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    }
    if (packet.kind === 'patrol') {
      const { areaId, coverage } = packet.payload as PatrolPayload;
      return `${areaName(areaId)} 覆盖率 ${coverage}%`;
    }
    const { areaId, missionTitle } = packet.payload as DispatchPayload;
    return `${areaName(areaId)} · ${missionTitle}`;
  };

  const queuedPackets = packets.filter((packet) => packet.status === 'queued');
  const reviewPackets = packets.filter((packet) => packet.status === 'pending_review');
  const failedPackets = packets.filter((packet) => packet.status === 'failed');
  const historyPackets = packets.filter((packet) => packet.status === 'history_only');
  const appliedPackets = packets.filter((packet) => packet.status === 'applied');

  const counts = [
    ['待补传', queuedPackets.length, 'yellow'],
    ['待核对', reviewPackets.length, 'orange'],
    ['补传失败', failedPackets.length, 'red'],
    ['已生效', appliedPackets.length, 'teal']
  ] as const;

  const renderPacketRow = (packet: SyncPacket, extra?: ReactNode) => (
    <Table.Tr key={packet.id}>
      <Table.Td><Badge variant="light" color={STATUS_META[packet.status].color}>{STATUS_META[packet.status].label}</Badge></Table.Td>
      <Table.Td>{assetName(packet.assetId)}</Table.Td>
      <Table.Td><Text size="sm">{PACKET_KIND_LABEL[packet.kind]}</Text></Table.Td>
      <Table.Td><Text size="sm">#{packet.seq}</Text></Table.Td>
      <Table.Td><Text size="sm">{payloadText(packet)}</Text></Table.Td>
      <Table.Td><Text size="xs" c="dimmed">观{clock(packet.observedAt)} · 收{clock(packet.receivedAt)}</Text></Table.Td>
      <Table.Td>
        {packet.reason && <Badge variant="outline" color={STATUS_META[packet.status].color} mb={extra ? 4 : 0}>{REASON_LABEL[packet.reason]}</Badge>}
        {extra}
      </Table.Td>
    </Table.Tr>
  );

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <div>
            <Title order={3}>离线补传合并</Title>
            <Text size="sm" c="dimmed" mt={4}>
              断链期间巡视、位置、任务调派缓存为补传包；网络恢复后按当前有效版本（业务序号）合并，同单位同一观测时刻的重复位置留待核对。
            </Text>
          </div>
          <Group>
            <Switch label="下次补传失败" checked={failNextSync} onChange={toggleFailNextSync} />
            <Switch label={offline ? '断链中' : '链路在线'} checked={offline} onChange={toggleOffline} color="red" />
            <Button onClick={flushBackfill} disabled={queuedPackets.length === 0} color="teal">
              恢复网络并补传{queuedPackets.length > 0 ? `（${queuedPackets.length} 包）` : ''}
            </Button>
            <Button variant="light" color="red" onClick={retryFailedPackets} disabled={failedPackets.length === 0}>
              重试失败包（{failedPackets.length}）
            </Button>
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 2, md: 4 }} mt="md">
          {counts.map(([label, value, color]) => (
            <Card key={label} withBorder padding="sm">
              <Text size="xs" c="dimmed">{label}</Text>
              <Title order={2} c={value > 0 ? color : undefined}>{value}</Title>
            </Card>
          ))}
        </SimpleGrid>
      </Card>

      <Card withBorder>
        <Title order={4}>当前有效位置</Title>
        <Text size="xs" c="dimmed" mb="sm">仅显示已按版本生效的位置；过期位置（观测/接收超 10 分钟）红色提示，不会被旧补传覆盖。</Text>
        <Table striped withTableBorder>
          <Table.Thead><Table.Tr>
            <Table.Th>救援单位</Table.Th><Table.Th>状态</Table.Th><Table.Th>当前坐标</Table.Th>
            <Table.Th>观测时刻</Table.Th><Table.Th>最后接收</Table.Th><Table.Th>位置版本</Table.Th>
          </Table.Tr></Table.Thead>
          <Table.Tbody>
            {assets.map((asset) => <EffectivePositionRow key={asset.id} asset={asset} />)}
          </Table.Tbody>
        </Table>
      </Card>

      {reviewPackets.length > 0 && (
        <Card withBorder>
          <Title order={4} c="orange">待核对包（{reviewPackets.length}）</Title>
          <Text size="xs" c="dimmed" mb="sm">同一单位同一观测时刻出现两条位置，较新接收的已定当前值；请核对落败包后手工裁决。</Text>
          <Table striped withTableBorder>
            <Table.Thead><Table.Tr>
              <Table.Th>状态</Table.Th><Table.Th>单位</Table.Th><Table.Th>业务</Table.Th><Table.Th>序号</Table.Th>
              <Table.Th>内容</Table.Th><Table.Th>时刻</Table.Th><Table.Th>核对操作</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {reviewPackets.map((packet) => renderPacketRow(packet, (
                <Group gap="xs" mt={2}>
                  <Button size="compact-xs" color="teal" onClick={() => resolveReviewPacket(packet.id, 'accept')}>采信用</Button>
                  <Button size="compact-xs" variant="default" onClick={() => resolveReviewPacket(packet.id, 'reject')}>驳回</Button>
                </Group>
              )))}
            </Table.Tbody>
          </Table>
          {reviewPackets.some((p) => p.note) && (
            <Stack gap={4} mt="sm">
              {reviewPackets.filter((p) => p.note).map((p) => (
                <Text key={p.id} size="xs" c="dimmed">· {p.id}：{p.note}</Text>
              ))}
            </Stack>
          )}
        </Card>
      )}

      {(failedPackets.length > 0 || queuedPackets.length > 0) && (
        <Card withBorder>
          <Title order={4}>补传队列与失败重试</Title>
          <Text size="xs" c="dimmed" mb="sm">补传失败时原包完整保留，恢复后按原序号重试；已生效的任务与覆盖率不会回退。</Text>
          <Table striped withTableBorder>
            <Table.Thead><Table.Tr>
              <Table.Th>状态</Table.Th><Table.Th>单位</Table.Th><Table.Th>业务</Table.Th><Table.Th>序号</Table.Th>
              <Table.Th>内容</Table.Th><Table.Th>时刻</Table.Th><Table.Th>操作 / 尝试</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {[...queuedPackets, ...failedPackets].map((packet) => renderPacketRow(packet, packet.status === 'failed' ? (
                <Group gap="xs" mt={2} align="center">
                  <Button size="compact-xs" color="red" onClick={() => retryPacket(packet.id)}>恢复原包并重试</Button>
                  <Text size="xs" c="dimmed">已尝试 {packet.attempts} 次</Text>
                </Group>
              ) : undefined))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {historyPackets.length > 0 && (
        <Card withBorder>
          <Title order={4}>历史与阻塞（{historyPackets.length}）</Title>
          <Text size="xs" c="dimmed" mb="sm">搜索区已关闭、单位已失联、任务单容量不足或旧版本的补传只留历史，不改当前调派。</Text>
          <Table striped withTableBorder>
            <Table.Thead><Table.Tr>
              <Table.Th>状态</Table.Th><Table.Th>单位</Table.Th><Table.Th>业务</Table.Th><Table.Th>序号</Table.Th>
              <Table.Th>内容</Table.Th><Table.Th>时刻</Table.Th><Table.Th>阻塞原因</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {historyPackets.map((packet) => renderPacketRow(packet, packet.reason && packet.note && packet.note !== REASON_LABEL[packet.reason]
                ? <Text size="xs" c="dimmed" mt={2}>{packet.note}</Text>
                : undefined))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {appliedPackets.length > 0 && (
        <Card withBorder>
          <Title order={4}>已生效补传（{appliedPackets.length}）</Title>
          <Table striped withTableBorder>
            <Table.Thead><Table.Tr>
              <Table.Th>状态</Table.Th><Table.Th>单位</Table.Th><Table.Th>业务</Table.Th><Table.Th>序号</Table.Th>
              <Table.Th>内容</Table.Th><Table.Th>观测 / 生效</Table.Th><Table.Th>说明</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {appliedPackets.map((packet) => (
                <Table.Tr key={packet.id}>
                  <Table.Td><Badge variant="light" color="teal">已生效</Badge></Table.Td>
                  <Table.Td>{assetName(packet.assetId)}</Table.Td>
                  <Table.Td>{PACKET_KIND_LABEL[packet.kind]}</Table.Td>
                  <Table.Td>#{packet.seq}</Table.Td>
                  <Table.Td><Text size="sm">{payloadText(packet)}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">观{clock(packet.observedAt)} · 生效{clock(packet.appliedAt)}</Text></Table.Td>
                  <Table.Td>{packet.note && <Text size="xs" c="dimmed">{packet.note}</Text>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}

function EffectivePositionRow({ asset }: { asset: RescueAsset }) {
  const observedAge = Date.now() - new Date(asset.observedAt).getTime();
  const receivedAge = Date.now() - new Date(asset.lastSeen).getTime();
  const stale = Math.min(observedAge, receivedAge) > 10 * 60_000;
  const offline = asset.status === 'offline';
  return (
    <Table.Tr>
      <Table.Td><b>{asset.name}</b></Table.Td>
      <Table.Td><Badge color={offline ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'} variant="light">{asset.status}</Badge></Table.Td>
      <Table.Td>
        <Text size="sm" c={offline ? 'red' : undefined}>{asset.lat.toFixed(3)}, {asset.lng.toFixed(3)}</Text>
        {(stale || offline) && <Text size="xs" c="red">{offline ? '单位失联 · ' : '位置已过期 · '}观测于 {formatDistanceToNow(new Date(asset.observedAt), { addSuffix: true, locale: zhCN })}</Text>}
      </Table.Td>
      <Table.Td><Text size="xs" c={observedAge > 10 * 60_000 ? 'red' : 'dimmed'}>{clock(asset.observedAt)}</Text></Table.Td>
      <Table.Td><Text size="xs" c="dimmed">{clock(asset.lastSeen)}</Text></Table.Td>
      <Table.Td><Badge variant="outline">#{asset.positionVersion}</Badge></Table.Td>
    </Table.Tr>
  );
}
