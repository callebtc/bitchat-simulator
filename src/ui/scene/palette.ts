import * as THREE from 'three';

import { MessageType, BitchatPacket } from '../../protocol/BitchatPacket';
import { RSSI_CONFIG } from '../../simulation/BitchatConnectionBLE';
import { getPeerColor } from '../../utils/colorUtils';
import { hashUnit } from '../../simulation/environment/BuildingHeights';

/** Shared, allocation-free color lookups for scene layers. */

const peerColorCache = new Map<string, THREE.Color>();

/** Linear-space peer identity color (stable per peerID). */
export function peerColor(peerIdHex: string): THREE.Color {
    let c = peerColorCache.get(peerIdHex);
    if (!c) {
        c = new THREE.Color(getPeerColor(peerIdHex));
        peerColorCache.set(peerIdHex, c);
    }
    return c;
}

const SKIN_TONES = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa86b3c].map(h =>
    new THREE.Color(h)
);
const TROUSER_TONES = [0x1f2937, 0x283548, 0x3b3330, 0x22303a, 0x47505e, 0x2b2b33].map(h =>
    new THREE.Color(h)
);

export function skinTone(peerIdHex: string): THREE.Color {
    return SKIN_TONES[Math.floor(hashUnit(peerIdHex + 's') * SKIN_TONES.length)];
}

export function trouserTone(peerIdHex: string): THREE.Color {
    return TROUSER_TONES[Math.floor(hashUnit(peerIdHex + 't') * TROUSER_TONES.length)];
}

/** Packet type → visual hue (matches legend in the HUD). */
export const PACKET_COLORS = {
    announce: 0x22d3ee,
    message: 0x4ade80,
    noise: 0xe879f9,
    fragment: 0xfb923c,
    voice: 0xf43f5e,
    sync: 0x38bdf8,
    routed: 0xfbbf24,
    other: 0xe5e7eb,
} as const;

export function packetColorHex(packet: BitchatPacket): number {
    if (packet.route && packet.route.length > 0) return PACKET_COLORS.routed;
    switch (packet.type) {
        case MessageType.ANNOUNCE:
            return PACKET_COLORS.announce;
        case MessageType.MESSAGE:
            return PACKET_COLORS.message;
        case MessageType.NOISE_HANDSHAKE:
        case MessageType.NOISE_ENCRYPTED:
            return PACKET_COLORS.noise;
        case MessageType.FRAGMENT:
        case MessageType.FILE_TRANSFER:
            return PACKET_COLORS.fragment;
        case MessageType.VOICE_FRAME:
            return PACKET_COLORS.voice;
        case MessageType.REQUEST_SYNC:
            return PACKET_COLORS.sync;
        default:
            return PACKET_COLORS.other;
    }
}

/** BLE link quality color: red at disconnect threshold → amber → green at strong RSSI. */
export function writeRssiColor(rssi: number, out: THREE.Color): THREE.Color {
    const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
    const t = Math.max(0, Math.min(1, (rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range));
    return out.setHSL((t * 135) / 360, 0.85, 0.55);
}
