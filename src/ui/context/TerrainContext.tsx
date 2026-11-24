import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useSimulation } from './SimulationContext';
import { usePersistedState } from '../../utils/usePersistedState';
import {
    buildHeightfieldFromTiles,
    ElevationTile,
    Heightfield,
    TERRARIUM_TILE_SIZE,
    TERRARIUM_ZOOM,
    tilesCovering,
    decodeTerrarium,
} from '../../simulation/environment/Terrain';

/**
 * Ground elevation for the loaded map area, shared by every 3D layer and DOM
 * overlay. `heightAt(x, y)` is safe to call per frame (bilinear lookup) and
 * returns 0 when no map is loaded.
 */

export type TerrainStatus = 'none' | 'loading' | 'ready' | 'flat' | 'error';

interface TerrainContextType {
    field: Heightfield | null;
    status: TerrainStatus;
    enabled: boolean;
    setEnabled: (on: boolean) => void;
    /** Live ref for imperative per-frame code (render loops, projectors). */
    fieldRef: React.MutableRefObject<Heightfield | null>;
    heightAt: (x: number, y: number) => number;
}

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const AREA_MARGIN_M = 160;
const MAX_HALF_EXTENT_M = 1400;
const tileCache = new Map<string, Promise<ElevationTile>>();

async function fetchTile(x: number, y: number): Promise<ElevationTile> {
    const key = `${TERRARIUM_ZOOM}/${x}/${y}`;
    let pending = tileCache.get(key);
    if (!pending) {
        pending = (async () => {
            const res = await fetch(`${TERRARIUM_URL}/${key}.png`);
            if (!res.ok) throw new Error(`DEM tile ${key}: HTTP ${res.status}`);
            const bitmap = await createImageBitmap(await res.blob());
            const S = TERRARIUM_TILE_SIZE;
            const canvas = document.createElement('canvas');
            canvas.width = S;
            canvas.height = S;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('2D canvas unavailable');
            ctx.drawImage(bitmap, 0, 0);
            const px = ctx.getImageData(0, 0, S, S).data;
            const heights = new Float32Array(S * S);
            for (let i = 0; i < S * S; i++) {
                heights[i] = decodeTerrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
            }
            bitmap.close();
            return { z: TERRARIUM_ZOOM, x, y, heights };
        })();
        tileCache.set(key, pending);
        pending.catch(() => tileCache.delete(key));
    }
    return pending;
}

const fieldRefDefault: React.MutableRefObject<Heightfield | null> = { current: null };

const TerrainContext = createContext<TerrainContextType>({
    field: null,
    status: 'none',
    enabled: true,
    setEnabled: () => {},
    fieldRef: fieldRefDefault,
    heightAt: () => 0,
});

export const TerrainProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const engine = useSimulation();
    const [enabled, setEnabled] = usePersistedState('viz_terrain', true);
    const [field, setField] = useState<Heightfield | null>(null);
    const [status, setStatus] = useState<TerrainStatus>('none');
    const [envVersion, setEnvVersion] = useState(0);
    const fieldRef = useRef<Heightfield | null>(null);

    useEffect(() => {
        const bump = () => setEnvVersion(v => v + 1);
        engine.events.on('environment_loaded', bump);
        engine.events.on('reset', bump);
        return () => {
            engine.events.off('environment_loaded', bump);
            engine.events.off('reset', bump);
        };
    }, [engine]);

    useEffect(() => {
        let cancelled = false;
        const bounds = engine.environment.getBounds();
        if (!bounds || engine.environment.getBuildingCount() === 0) {
            fieldRef.current = null;
            setField(null);
            setStatus('none');
            return;
        }
        const lb = bounds.localBounds;
        const cx = (lb.minX + lb.maxX) / 2;
        const cy = (lb.minY + lb.maxY) / 2;
        const hx = Math.min(MAX_HALF_EXTENT_M, (lb.maxX - lb.minX) / 2 + AREA_MARGIN_M);
        const hy = Math.min(MAX_HALF_EXTENT_M, (lb.maxY - lb.minY) / 2 + AREA_MARGIN_M);
        const [minX, minY, maxX, maxY] = [cx - hx, cy - hy, cx + hx, cy + hy];
        const flat = Heightfield.flat(minX, minY, maxX, maxY);

        // Show the flat map immediately; swap in the DEM when tiles arrive
        fieldRef.current = flat;
        setField(flat);
        if (!enabled) {
            setStatus('flat');
            return;
        }
        setStatus('loading');
        const { lat, lng } = bounds.center;
        const keys = tilesCovering(lat, lng, minX, minY, maxX, maxY);
        Promise.all(keys.map(k => fetchTile(k.x, k.y)))
            .then(tiles => {
                if (cancelled) return;
                const hf = buildHeightfieldFromTiles(tiles, lat, lng, minX, minY, maxX, maxY, 4);
                fieldRef.current = hf;
                setField(hf);
                setStatus('ready');
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('[Terrain] Elevation unavailable, using flat ground:', err);
                setStatus('error');
            });
        return () => {
            cancelled = true;
        };
    }, [engine, envVersion, enabled]);

    const value = useMemo<TerrainContextType>(
        () => ({
            field,
            status,
            enabled,
            setEnabled,
            fieldRef,
            heightAt: (x: number, y: number) => fieldRef.current?.sample(x, y) ?? 0,
        }),
        [field, status, enabled, setEnabled]
    );

    return <TerrainContext.Provider value={value}>{children}</TerrainContext.Provider>;
};

export const useTerrain = (): TerrainContextType => useContext(TerrainContext);
