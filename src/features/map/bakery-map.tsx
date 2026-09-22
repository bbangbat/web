"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CustomOverlayMap, Map, useKakaoLoader } from "react-kakao-maps-sdk";
import { Croissant, Crosshair, Minus, Plus, Search } from "lucide-react";
import type { Congestion, Coordinates, Store } from "@/entities/types";
import { env } from "@/shared/config/env";
import { congestionCopy, DAEJEON_BOUNDS, DEFAULT_LOCATION } from "@/shared/lib/format";
import type { LocationStatus } from "@/shared/hooks/use-geolocation";
import { resolveSearchAreaPixels } from "@/features/map/map-search-area";

export const INITIAL_MAP_LEVEL = 4;

type MapFocusRequest = {
  id: number;
  center: Coordinates;
  level: number;
  offsetForPanel: boolean;
  preserveLevel?: boolean;
};

export type MapViewport = {
  center: Coordinates;
  bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  };
  level: number;
};

type BakeryMapProps = {
  center: Coordinates;
  focusRequest: MapFocusRequest;
  userLocation: Coordinates | null;
  locationStatus: LocationStatus;
  stores: Store[];
  congestionByStore: ReadonlyMap<number, Congestion>;
  selectedStoreId: number | null;
  onSelect: (storeId: number) => void;
  onLocate: () => void;
  onSearchHere: (viewport: MapViewport) => void;
  mobileSearchBottomInset: number;
  onMapClick: () => void;
  onViewportChange: (viewport: MapViewport) => void;
};

function MapUnavailable({ onLocate }: Pick<BakeryMapProps, "onLocate">) {
  return (
    <div className="map-fallback">
      <div className="map-field-lines" aria-hidden="true" />
      <div className="map-fallback-copy">
        <strong>지도를 준비하고 있어요</strong>
        <p>카카오 지도 키를 설정하면 내 주변 빵집을 지도에서 볼 수 있어요.</p>
      </div>
      <button type="button" className="map-locate-button" onClick={onLocate} aria-label="현재 위치" title="현재 위치">
        <Crosshair aria-hidden="true" size={18} />
      </button>
    </div>
  );
}

function KakaoMapCanvas(props: BakeryMapProps) {
  const [loading, error] = useKakaoLoader({
    appkey: env.kakaoMapAppKey,
    libraries: ["services"],
  });
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const mapControlStackRef = useRef<HTMLDivElement>(null);
  const searchCurrentAreaButtonRef = useRef<HTMLButtonElement>(null);
  const initialViewportFrameRef = useRef<number | null>(null);
  const mapMovementFrameRef = useRef<number | null>(null);
  const mapMovementActiveRef = useRef(false);
  const mapDragRef = useRef(false);
  const markerPointerRef = useRef<{
    pointerId: number;
    storeId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [mapLevel, setMapLevel] = useState(INITIAL_MAP_LEVEL);
  const [maximumLevel, setMaximumLevel] = useState(7);
  const showStoreNames = mapLevel <= 5;
  const markerOffsetByStore = useMemo(() => {
    const groups = new globalThis.Map<string, Store[]>();
    const offsets = new globalThis.Map<number, { x: number; y: number }>();

    for (const store of props.stores) {
      const key = `${store.latitude.toFixed(6)}:${store.longitude.toFixed(6)}`;
      const group = groups.get(key) ?? [];
      group.push(store);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (group.length === 1) {
        offsets.set(group[0]!.id, { x: 0, y: 0 });
        continue;
      }
      const radius = showStoreNames ? 66 : 20;
      group.forEach((store, index) => {
        const angle = group.length === 2
          ? index * Math.PI
          : -Math.PI / 2 + (index * Math.PI * 2) / group.length;
        offsets.set(store.id, {
          x: Math.round(Math.cos(angle) * radius),
          y: Math.round(Math.sin(angle) * radius),
        });
      });
    }

    return offsets;
  }, [props.stores, showStoreNames]);

  const getFocusedCenter = useCallback((map: kakao.maps.Map, storeCenter: kakao.maps.LatLng) => {
    if (!props.focusRequest.offsetForPanel) return storeCenter;
    const projection = map.getProjection();
    const storePoint = projection.pointFromCoords(storeCenter);
    const desktop = window.matchMedia("(min-width: 901px)").matches;
    const centerOffsetX = desktop ? -190 : 0;
    const centerOffsetY = desktop ? 0 : props.mobileSearchBottomInset / 2;
    return projection.coordsFromPoint(new kakao.maps.Point(
      storePoint.x + centerOffsetX,
      storePoint.y + centerOffsetY,
    ));
  }, [props.focusRequest.offsetForPanel, props.mobileSearchBottomInset]);

  const cancelMapMovement = useCallback(() => {
    if (mapMovementFrameRef.current !== null) {
      window.cancelAnimationFrame(mapMovementFrameRef.current);
    }
    mapMovementFrameRef.current = null;
    mapMovementActiveRef.current = false;
    mapWrapRef.current?.removeAttribute("data-moving");
  }, []);

  const animateMapCenter = useCallback((map: kakao.maps.Map, target: kakao.maps.LatLng) => {
    cancelMapMovement();
    const start = map.getCenter();
    const projection = map.getProjection();
    const startPoint = projection.containerPointFromCoords(start);
    const targetPoint = projection.containerPointFromCoords(target);
    const pixelDistance = Math.hypot(targetPoint.x - startPoint.x, targetPoint.y - startPoint.y);

    if (pixelDistance < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      map.setCenter(target);
      return;
    }

    const duration = Math.min(380, Math.max(190, 170 + pixelDistance * .055));
    const startedAt = performance.now();
    let lastRenderedAt = startedAt - 24;
    const startLatitude = start.getLat();
    const startLongitude = start.getLng();
    const latitudeDistance = target.getLat() - startLatitude;
    const longitudeDistance = target.getLng() - startLongitude;
    mapMovementActiveRef.current = true;
    mapWrapRef.current?.setAttribute("data-moving", "true");

    const move = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      if (progress < 1 && now - lastRenderedAt < 24) {
        mapMovementFrameRef.current = window.requestAnimationFrame(move);
        return;
      }
      lastRenderedAt = now;
      const eased = progress * progress * (3 - 2 * progress);
      map.setCenter(new kakao.maps.LatLng(
        startLatitude + latitudeDistance * eased,
        startLongitude + longitudeDistance * eased,
      ));
      if (progress < 1) {
        mapMovementFrameRef.current = window.requestAnimationFrame(move);
      } else {
        mapMovementFrameRef.current = null;
        mapMovementActiveRef.current = false;
        mapWrapRef.current?.removeAttribute("data-moving");
      }
    };

    mapMovementFrameRef.current = window.requestAnimationFrame(move);
  }, [cancelMapMovement]);

  function configureZoomBounds(map: kakao.maps.Map) {
    const bounds = map.getBounds();
    const latitudeSpan = bounds.getNorthEast().getLat() - bounds.getSouthWest().getLat();
    const longitudeSpan = bounds.getNorthEast().getLng() - bounds.getSouthWest().getLng();
    const daejeonLatitudeSpan = DAEJEON_BOUNDS.north - DAEJEON_BOUNDS.south;
    const daejeonLongitudeSpan = DAEJEON_BOUNDS.east - DAEJEON_BOUNDS.west;
    const fitRatio = Math.min(
      daejeonLatitudeSpan / latitudeSpan,
      daejeonLongitudeSpan / longitudeSpan,
    );
    const additionalLevels = Math.floor(Math.log2(Math.max(fitRatio, 0.01)));
    const nextMaximumLevel = Math.min(8, Math.max(1, map.getLevel() + additionalLevels));

    map.setMinLevel(1);
    map.setMaxLevel(nextMaximumLevel);
    if (map.getLevel() > nextMaximumLevel) map.setLevel(nextMaximumLevel);
    setMaximumLevel((current) => current === nextMaximumLevel ? current : nextMaximumLevel);
  }

  function constrainToDaejeon(map: kakao.maps.Map) {
    const bounds = map.getBounds();
    const center = map.getCenter();
    const latitudeHalfSpan = (bounds.getNorthEast().getLat() - bounds.getSouthWest().getLat()) / 2;
    const longitudeHalfSpan = (bounds.getNorthEast().getLng() - bounds.getSouthWest().getLng()) / 2;
    const minimumLatitude = DAEJEON_BOUNDS.south + latitudeHalfSpan;
    const maximumLatitude = DAEJEON_BOUNDS.north - latitudeHalfSpan;
    const minimumLongitude = DAEJEON_BOUNDS.west + longitudeHalfSpan;
    const maximumLongitude = DAEJEON_BOUNDS.east - longitudeHalfSpan;
    const latitude =
      minimumLatitude > maximumLatitude
        ? DEFAULT_LOCATION.latitude
        : Math.min(maximumLatitude, Math.max(minimumLatitude, center.getLat()));
    const longitude =
      minimumLongitude > maximumLongitude
        ? DEFAULT_LOCATION.longitude
        : Math.min(maximumLongitude, Math.max(minimumLongitude, center.getLng()));

    if (latitude !== center.getLat() || longitude !== center.getLng()) {
      map.setCenter(new kakao.maps.LatLng(latitude, longitude));
    }
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map || loading || error) return;
    cancelMapMovement();
    const requestedLevel = props.focusRequest.preserveLevel
      ? map.getLevel()
      : Math.min(maximumLevel, Math.max(1, props.focusRequest.level));
    const storeCenter = new kakao.maps.LatLng(
      props.focusRequest.center.latitude,
      props.focusRequest.center.longitude,
    );
    const moveToStore = () => {
      animateMapCenter(map, getFocusedCenter(map, storeCenter));
    };

    if (props.focusRequest.preserveLevel || map.getLevel() === requestedLevel) {
      moveToStore();
    } else {
      map.setLevel(requestedLevel);
      setMapLevel(requestedLevel);
      mapMovementFrameRef.current = window.requestAnimationFrame(() => {
        mapMovementFrameRef.current = window.requestAnimationFrame(moveToStore);
      });
    }

    return cancelMapMovement;
  }, [animateMapCenter, cancelMapMovement, error, getFocusedCenter, loading, maximumLevel, props.focusRequest]);

  useEffect(() => () => {
    if (initialViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(initialViewportFrameRef.current);
    }
  }, []);

  if (loading) return <div className="map-loading">지도를 불러오는 중…</div>;
  if (error) return <MapUnavailable onLocate={props.onLocate} />;

  function zoomIn() {
    const map = mapRef.current;
    if (!map || map.getLevel() <= 1) return;
    map.setLevel(map.getLevel() - 1);
  }

  function zoomOut() {
    const map = mapRef.current;
    if (!map || map.getLevel() >= maximumLevel) return;
    map.setLevel(map.getLevel() + 1);
  }

  function getSearchViewport(map: kakao.maps.Map, restrictToControls = false): MapViewport {
    const fullBounds = map.getBounds();
    const mapElement = mapWrapRef.current;
    if (!mapElement) {
      const center = map.getCenter();
      return {
        center: { latitude: center.getLat(), longitude: center.getLng() },
        bounds: {
          south: fullBounds.getSouthWest().getLat(),
          north: fullBounds.getNorthEast().getLat(),
          west: fullBounds.getSouthWest().getLng(),
          east: fullBounds.getNorthEast().getLng(),
        },
        level: map.getLevel(),
      };
    }
    const isMobile = window.matchMedia("(max-width: 900px)").matches;
    const useVisibleMobileArea = isMobile
      && props.mobileSearchBottomInset > 0;

    if (!useVisibleMobileArea && !restrictToControls) {
      const center = map.getCenter();
      return {
        center: { latitude: center.getLat(), longitude: center.getLng() },
        bounds: {
          south: fullBounds.getSouthWest().getLat(),
          north: fullBounds.getNorthEast().getLat(),
          west: fullBounds.getSouthWest().getLng(),
          east: fullBounds.getNorthEast().getLng(),
        },
        level: map.getLevel(),
      };
    }

    const width = Math.max(1, mapElement.clientWidth);
    const height = Math.max(1, mapElement.clientHeight);
    const mapRect = mapElement.getBoundingClientRect();
    const controlsRect = restrictToControls
      ? mapControlStackRef.current?.getBoundingClientRect()
      : undefined;
    const searchButtonRect = restrictToControls
      ? searchCurrentAreaButtonRef.current?.getBoundingClientRect()
      : undefined;
    const searchArea = resolveSearchAreaPixels({
      width,
      height,
      mobileBottomInset: props.mobileSearchBottomInset,
      isMobile,
      restrictToControls,
      controlsRight: controlsRect
        ? controlsRect.right - mapRect.left
        : undefined,
      searchButtonBottom: searchButtonRect
        ? searchButtonRect.bottom - mapRect.top
        : undefined,
    });
    const projection = map.getProjection();
    const northEast = projection.coordsFromContainerPoint(new kakao.maps.Point(searchArea.right, 0));
    const southWest = projection.coordsFromContainerPoint(new kakao.maps.Point(0, searchArea.bottom));
    const visibleCenter = projection.coordsFromContainerPoint(new kakao.maps.Point(
      searchArea.right / 2,
      searchArea.bottom / 2,
    ));

    return {
      center: {
        latitude: visibleCenter.getLat(),
        longitude: visibleCenter.getLng(),
      },
      bounds: {
        south: southWest.getLat(),
        north: northEast.getLat(),
        west: southWest.getLng(),
        east: northEast.getLng(),
      },
      level: map.getLevel(),
    };
  }

  return (
    <div ref={mapWrapRef} className="map-wrap" data-map-level={mapLevel} data-max-map-level={maximumLevel}>
      <Map
        center={{ lat: props.center.latitude, lng: props.center.longitude }}
        isPanto
        level={mapLevel}
        zoomable
        scrollwheel
        keyboardShortcuts
        className="kakao-map"
        onCreate={(map) => {
          if (mapRef.current === map) return;
          mapRef.current = map;
          configureZoomBounds(map);
          constrainToDaejeon(map);
          const requestedLevel = props.focusRequest.preserveLevel
            ? map.getLevel()
            : Math.min(maximumLevel, Math.max(1, props.focusRequest.level));
          if (!props.focusRequest.preserveLevel) map.setLevel(requestedLevel);
          const storeCenter = new kakao.maps.LatLng(
            props.focusRequest.center.latitude,
            props.focusRequest.center.longitude,
          );
          map.setCenter(getFocusedCenter(map, storeCenter));
          setMapLevel(requestedLevel);
          initialViewportFrameRef.current = window.requestAnimationFrame(() => {
            initialViewportFrameRef.current = null;
            if (mapRef.current !== map) return;
            constrainToDaejeon(map);
            props.onViewportChange(getSearchViewport(map, true));
          });
        }}
        onCenterChanged={(map) => {
          if (!mapMovementActiveRef.current) constrainToDaejeon(map);
        }}
        onZoomChanged={(map) => {
          setMapLevel(map.getLevel());
          constrainToDaejeon(map);
        }}
        onBoundsChanged={(map) => {
          configureZoomBounds(map);
          if (!mapMovementActiveRef.current) constrainToDaejeon(map);
        }}
        onDragStart={() => {
          cancelMapMovement();
          mapDragRef.current = true;
        }}
        onDragEnd={() => {
          window.setTimeout(() => {
            mapDragRef.current = false;
          }, 0);
        }}
        onIdle={(map) => {
          if (mapMovementActiveRef.current) return;
          constrainToDaejeon(map);
          props.onViewportChange(getSearchViewport(map));
        }}
        onClick={props.onMapClick}
      >
        {props.userLocation ? (
          <CustomOverlayMap
            position={{ lat: props.userLocation.latitude, lng: props.userLocation.longitude }}
            xAnchor={0.5}
            yAnchor={0.5}
            zIndex={40}
          >
            <span className="user-location-marker" aria-label="내 현재 위치">
              <i aria-hidden="true" />
            </span>
          </CustomOverlayMap>
        ) : null}
        {props.stores.map((store) => {
          const selected = props.selectedStoreId === store.id;
          const showMarkerName = showStoreNames || selected;
          const congestion = props.congestionByStore.get(store.id);
          const congestionLabel = congestion ? congestionCopy[congestion.current].shortLabel : null;
          const markerOffset = markerOffsetByStore.get(store.id) ?? { x: 0, y: 0 };
          return (
            <CustomOverlayMap
              key={store.id}
              position={{ lat: store.latitude, lng: store.longitude }}
              xAnchor={0.5}
              yAnchor={0.5}
              zIndex={selected ? 20 : 10}
            >
              <div
                className="bakery-label-marker"
                data-selected={selected}
                data-name-visible={showMarkerName}
                style={{
                  "--marker-offset-x": `${markerOffset.x}px`,
                  "--marker-offset-y": `${markerOffset.y}px`,
                } as CSSProperties}
              >
                {congestion ? (
                  <span
                    className="bakery-label-status"
                    data-compact={!showStoreNames}
                    data-level={congestion.current.toLowerCase()}
                    aria-hidden="true"
                  >
                    {showStoreNames ? congestionLabel : null}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="bakery-label-icon"
                  aria-label={congestionLabel ? `${store.name}, 혼잡도 ${congestionLabel}` : store.name}
                  onPointerDown={(event) => {
                    markerPointerRef.current = {
                      pointerId: event.pointerId,
                      storeId: store.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      moved: false,
                    };
                  }}
                  onPointerMove={(event) => {
                    const pointer = markerPointerRef.current;
                    if (
                      !pointer
                      || pointer.pointerId !== event.pointerId
                      || pointer.storeId !== store.id
                    ) return;
                    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= 6) {
                      pointer.moved = true;
                    }
                  }}
                  onPointerCancel={() => {
                    markerPointerRef.current = null;
                  }}
                  onClick={(event) => {
                    const pointer = markerPointerRef.current;
                    const dragged = mapDragRef.current
                      || (pointer?.storeId === store.id && pointer.moved);
                    markerPointerRef.current = null;
                    if (dragged) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    props.onSelect(store.id);
                  }}
                >
                  <Croissant aria-hidden="true" size={14} />
                </button>
                {showMarkerName ? <span className="bakery-label-name">{store.name}</span> : null}
              </div>
            </CustomOverlayMap>
          );
        })}
      </Map>

      <div ref={mapControlStackRef} className="map-control-stack" aria-label="지도 확대 축소">
        <button type="button" onClick={zoomIn} disabled={mapLevel <= 1} aria-label="지도 확대" title="지도 확대">
          <Plus aria-hidden="true" size={19} />
        </button>
        <button type="button" onClick={zoomOut} disabled={mapLevel >= maximumLevel} aria-label="지도 축소" title="지도 축소">
          <Minus aria-hidden="true" size={19} />
        </button>
      </div>
      <button
        type="button"
        className="map-locate-button"
        data-loading={props.locationStatus === "locating"}
        onClick={props.onLocate}
        disabled={props.locationStatus === "locating"}
        aria-label="현재 위치"
        title="현재 위치"
      >
        <Crosshair aria-hidden="true" size={18} />
      </button>
      <button
        ref={searchCurrentAreaButtonRef}
        type="button"
        className="map-search-here"
        onClick={() => {
          const map = mapRef.current;
          if (map) props.onSearchHere(getSearchViewport(map, true));
        }}
      >
        <Search aria-hidden="true" size={16} /> 현재 위치에서 검색
      </button>
    </div>
  );
}

export function BakeryMap(props: BakeryMapProps) {
  if (!env.kakaoMapAppKey) return <MapUnavailable onLocate={props.onLocate} />;
  return <KakaoMapCanvas {...props} />;
}
