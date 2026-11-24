import { describe, it, expect } from 'vitest';
import {
    BitchatPacket,
    MessageType,
    SpecialRecipients,
    computePacketIdHex,
    createPacket,
} from '../BitchatPacket';
import { BinaryProtocol, PacketFlags } from '../BinaryProtocol';
import { MessagePadding } from '../MessagePadding';
import { CompressionUtil } from '../CompressionUtil';
import { MAX_DIRECT_NEIGHBORS, TLV, TLVType } from '../TLV';

describe('Wire Codec Parity (Android & iOS)', () => {
    it('applies PKCS#7 padding selectively to Noise frames only', () => {
        expect(MessagePadding.shouldPadForBLE(MessageType.NOISE_HANDSHAKE)).toBe(true);
        expect(MessagePadding.shouldPadForBLE(MessageType.NOISE_ENCRYPTED)).toBe(true);
        expect(MessagePadding.shouldPadForBLE(MessageType.MESSAGE)).toBe(false);
        expect(MessagePadding.shouldPadForBLE(MessageType.ANNOUNCE)).toBe(false);
        expect(MessagePadding.shouldPadForBLE(MessageType.FRAGMENT)).toBe(false);

        const sender = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const recipient = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
        const noisePayload = new Uint8Array(64).fill(0xab);

        const noisePkt = createPacket(
            MessageType.NOISE_ENCRYPTED,
            sender,
            noisePayload,
            7,
            recipient,
            1000
        );
        const encoded = BinaryProtocol.encode(noisePkt);
        expect(encoded).not.toBeNull();
        // Raw size is 14 + 8 + 8 + 64 = 94 -> optimalBlockSize(94) = 256 -> padded to 256 bytes
        expect(encoded!.length).toBe(256);

        const decoded = BinaryProtocol.decode(encoded!);
        expect(decoded).not.toBeNull();
        expect(decoded!.payload).toEqual(noisePayload);
        expect(decoded!.recipientID).toEqual(recipient);
    });

    it('emits unpadded frame when padding needed exceeds 255 bytes', () => {
        const data = new Uint8Array(250).fill(0x33);
        // optimalBlockSize(250): 250 + 16 = 266 -> 512; paddingNeeded = 262 > 255 -> unpadded
        const target = MessagePadding.optimalBlockSize(data.length);
        expect(target).toBe(512);
        const padded = MessagePadding.pad(data, target);
        expect(padded.length).toBe(250);
    });

    it('compresses and decompresses repetitive payloads >= 100 bytes on v1 and v2', () => {
        const text = 'hello mesh world! '.repeat(20); // 360 bytes, highly compressible
        const payload = new TextEncoder().encode(text);
        expect(CompressionUtil.shouldCompress(payload)).toBe(true);

        const sender = new Uint8Array(8).fill(0x11);
        const v1 = createPacket(MessageType.MESSAGE, sender, payload, 7, SpecialRecipients.BROADCAST, 5000);
        const encodedV1 = BinaryProtocol.encode(v1);
        expect(encodedV1).not.toBeNull();
        // Flag bit IS_COMPRESSED (0x04) at offset 11
        expect(encodedV1![11] & PacketFlags.IS_COMPRESSED).toBe(PacketFlags.IS_COMPRESSED);
        expect(encodedV1!.length).toBeLessThan(payload.length);

        const decodedV1 = BinaryProtocol.decode(encodedV1!);
        expect(decodedV1).not.toBeNull();
        expect(decodedV1!.payload).toEqual(payload);

        // V2 with route + signature
        const v2: BitchatPacket = {
            ...v1,
            version: 2,
            route: [new Uint8Array(8).fill(0x22), new Uint8Array(8).fill(0x33)],
            signature: new Uint8Array(64).fill(0x99),
        };
        const encodedV2 = BinaryProtocol.encode(v2);
        expect(encodedV2).not.toBeNull();
        const decodedV2 = BinaryProtocol.decode(encodedV2!);
        expect(decodedV2).not.toBeNull();
        expect(decodedV2!.version).toBe(2);
        expect(decodedV2!.route).toEqual(v2.route);
        expect(decodedV2!.signature).toEqual(v2.signature);
        expect(decodedV2!.payload).toEqual(payload);
    });

    it('computes canonical packet ID independent of TTL, route, and signature', () => {
        const sender = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const payload = new Uint8Array([10, 20, 30]);
        const base = createPacket(MessageType.MESSAGE, sender, payload, 7, undefined, 123456);
        const relayed: BitchatPacket = {
            ...base,
            ttl: 3,
            version: 2,
            route: [new Uint8Array(8).fill(0xaa)],
            signature: new Uint8Array(64).fill(0xbb),
        };
        expect(computePacketIdHex(base)).toBe(computePacketIdHex(relayed));
        expect(computePacketIdHex(base).length).toBe(32); // 16 bytes = 32 hex chars

        // encodeForSigning zeroes TTL and strips signature
        const sigA = BinaryProtocol.encodeForSigning(base);
        const sigB = BinaryProtocol.encodeForSigning({ ...base, ttl: 2, signature: new Uint8Array(64) });
        expect(sigA).toEqual(sigB);
    });

    it('encodes full IdentityAnnouncement TLV with 10-neighbor cap and capabilities', () => {
        const neighbors: Uint8Array[] = [];
        for (let i = 0; i < 15; i++) {
            const id = new Uint8Array(8);
            id[7] = i;
            neighbors.push(id);
        }
        // Add duplicate
        neighbors.push(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));

        const payload = TLV.encodeIdentityAnnouncement({
            nickname: 'Alice',
            noisePublicKey: new Uint8Array(32).fill(0x12),
            signingPublicKey: new Uint8Array(32).fill(0x34),
            neighbors,
            capabilities: 0x0100,
        });

        const map = TLV.decode(payload);
        expect(TLV.decodeNickname(map.get(TLVType.NICKNAME)!)).toBe('Alice');
        expect(map.get(TLVType.NOISE_PUBLIC_KEY)!.length).toBe(32);
        expect(map.get(TLVType.SIGNING_PUBLIC_KEY)!.length).toBe(32);
        expect(TLV.decodeNeighbors(map.get(TLVType.DIRECT_NEIGHBORS)!).length).toBe(MAX_DIRECT_NEIGHBORS);
        expect(TLV.decodeCapabilities(map.get(TLVType.CAPABILITIES)!)).toBe(0x0100);
    });
});
