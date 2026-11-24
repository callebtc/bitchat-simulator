import * as THREE from 'three';

/**
 * Simplified solar model for a mid-latitude northern-hemisphere site.
 * Hour angle drives azimuth (east at 06:00, south at noon, west at 18:00) and
 * elevation follows a sinusoid peaking at `MAX_ELEVATION` — enough for
 * believable shadows, sky color and night lighting without an ephemeris.
 */
const MAX_ELEVATION = THREE.MathUtils.degToRad(62);

export interface SunState {
    /** Unit vector toward the sun in world space (Y-up). */
    direction: THREE.Vector3;
    elevation: number;
    /** 0 = full day, 1 = full night. */
    night: number;
    /** 0..1 strength of golden-hour tint. */
    golden: number;
    sunColor: THREE.Color;
    sunIntensity: number;
    skyColor: THREE.Color;
    groundColor: THREE.Color;
    hemiIntensity: number;
    /** Horizon color; also used as fog color so geometry dissolves into the sky. */
    fogColor: THREE.Color;
    zenithColor: THREE.Color;
}

const smooth = (e0: number, e1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

export function computeSunState(hour: number, out?: SunState): SunState {
    const s: SunState = out ?? {
        direction: new THREE.Vector3(),
        elevation: 0,
        night: 0,
        golden: 0,
        sunColor: new THREE.Color(),
        sunIntensity: 0,
        skyColor: new THREE.Color(),
        groundColor: new THREE.Color(),
        hemiIntensity: 0,
        fogColor: new THREE.Color(),
        zenithColor: new THREE.Color(),
    };

    const h = ((hour % 24) + 24) % 24;
    const azimuth = (h / 24) * Math.PI * 2; // compass, 0 = north
    const elevation = MAX_ELEVATION * Math.sin(((h - 6) / 12) * Math.PI);
    s.elevation = elevation;
    const cosE = Math.cos(elevation);
    s.direction.set(Math.sin(azimuth) * cosE, Math.sin(elevation), -Math.cos(azimuth) * cosE).normalize();

    const deg = THREE.MathUtils.radToDeg(elevation);
    s.night = 1 - smooth(-7, 4, deg);
    s.golden = smooth(-4, 3, deg) * (1 - smooth(8, 24, deg));

    // Sun: warm & weak near the horizon, neutral-white at altitude
    s.sunColor.setRGB(1.0, 0.94, 0.86).lerp(new THREE.Color(1.0, 0.52, 0.26), s.golden);
    s.sunIntensity = 3.6 * smooth(-3, 12, deg);

    const daySky = new THREE.Color(0.55, 0.72, 1.0);
    const duskSky = new THREE.Color(0.62, 0.45, 0.6);
    const nightSky = new THREE.Color(0.1, 0.14, 0.32);
    s.skyColor.copy(daySky).lerp(duskSky, s.golden).lerp(nightSky, s.night);
    s.groundColor.setRGB(0.28, 0.25, 0.22).lerp(new THREE.Color(0.05, 0.05, 0.08), s.night);
    s.hemiIntensity = 0.78 - 0.4 * s.night;

    const dayFog = new THREE.Color(0.66, 0.76, 0.88);
    const duskFog = new THREE.Color(0.86, 0.56, 0.42);
    // Night horizon carries a faint sodium-vapour city glow
    const nightFog = new THREE.Color(0.035, 0.035, 0.06);
    s.fogColor.copy(dayFog).lerp(duskFog, s.golden).lerp(nightFog, s.night);

    const dayZenith = new THREE.Color(0.16, 0.34, 0.72);
    const duskZenith = new THREE.Color(0.17, 0.2, 0.42);
    const nightZenith = new THREE.Color(0.004, 0.007, 0.022);
    s.zenithColor.copy(dayZenith).lerp(duskZenith, s.golden).lerp(nightZenith, s.night);
    return s;
}

export function formatClock(hour: number): string {
    const h = ((hour % 24) + 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}
