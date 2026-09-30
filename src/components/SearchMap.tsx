'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { RescueAsset, SearchArea } from '@/lib/types';

export function SearchMap({ areas, assets }: { areas: SearchArea[]; assets: RescueAsset[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const areasRef = useRef<SearchArea[]>(areas);
  const assetsRef = useRef<RescueAsset[]>(assets);

  // 初始化地图（仅一次）
  useEffect(() => {
    let disposed = false;
    void import('maplibre-gl').then(({ Map, Marker: MapMarker, LngLatBounds }) => {
      if (disposed || !containerRef.current) return;
      const map = new Map({ container: containerRef.current, center: [121.68, 30.82], zoom: 8.5, style: 'https://demotiles.maplibre.org/style.json' });
      mapRef.current = map;
      const renderAreas = () => {
        const currentAreas = areasRef.current;
        currentAreas.forEach((area) => {
          if (map.getSource(area.id)) return;
          map.addSource(area.id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[area.bounds[0], area.bounds[1]], [area.bounds[2], area.bounds[1]], [area.bounds[2], area.bounds[3]], [area.bounds[0], area.bounds[3]], [area.bounds[0], area.bounds[1]]]] } } });
          map.addLayer({ id: `${area.id}-fill`, type: 'fill', source: area.id, paint: { 'fill-color': area.status === 'active' ? '#0e7490' : area.status === 'closed' ? '#dc2626' : '#f59e0b', 'fill-opacity': .22 } });
          map.fitBounds(new LngLatBounds([area.bounds[0], area.bounds[1]], [area.bounds[2], area.bounds[3]]), { padding: 60 });
        });
      };
      const renderMarkers = () => {
        markersRef.current.forEach((marker) => marker.remove());
        markersRef.current = assetsRef.current.map((asset) => new MapMarker({ color: asset.status === 'offline' ? '#dc2626' : '#0f766e' }).setLngLat([asset.lng, asset.lat]).addTo(map));
      };
      map.on('load', () => { renderAreas(); renderMarkers(); });
      map.on('styledata', () => { if (map.loaded()) { renderAreas(); } });
      // 暴露给更新逻辑
      (map as unknown as { __renderAreas?: () => void; __renderMarkers?: () => void }).__renderAreas = renderAreas;
      (map as unknown as { __renderMarkers?: () => void }).__renderMarkers = renderMarkers;
    });
    return () => { disposed = true; markersRef.current.forEach((marker) => marker.remove()); mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // 搜索区变化时更新
  useEffect(() => {
    areasRef.current = areas;
    const map = mapRef.current as (MapLibreMap & { __renderAreas?: () => void }) | null;
    if (map && map.loaded()) map.__renderAreas?.();
  }, [areas]);

  // 单位位置变化时更新标记
  useEffect(() => {
    assetsRef.current = assets;
    const map = mapRef.current as (MapLibreMap & { __renderMarkers?: () => void }) | null;
    if (map && map.loaded()) map.__renderMarkers?.();
  }, [assets]);

  return <div ref={containerRef} className="map-shell" aria-label="搜救海域地图" />;
}
