import { describe, it, expect } from 'vitest';
import { TLV, TLVType } from '../TLV';

describe('TLV', () => {
    it('should encode and decode a nickname correctly', () => {
        const nickname = "Alice";
        const encoded = TLV.encodeNickname(nickname);
        
        // Structure check: Type(1) + Len(1) + Value
        expect(encoded[0]).toBe(TLVType.NICKNAME);
        expect(encoded[1]).toBe(nickname.length);
        
        const decodedMap = TLV.decode(encoded);
        expect(decodedMap.has(TLVType.NICKNAME)).toBe(true);
        
        const decodedNick = TLV.decodeNickname(decodedMap.get(TLVType.NICKNAME)!);
        expect(decodedNick).toBe(nickname);
    });

    it('should encode and decode neighbors correctly', () => {
        const p1 = new Uint8Array([1,1,1,1,1,1,1,1]);
        const p2 = new Uint8Array([2,2,2,2,2,2,2,2]);
        
        const encoded = TLV.encodeNeighbors([p1, p2]);
        
        // Structure check: Type(4) + Len(16) + Value
        expect(encoded[0]).toBe(TLVType.DIRECT_NEIGHBORS);
        expect(encoded[1]).toBe(16);
        
        const decodedMap = TLV.decode(encoded);
        expect(decodedMap.has(TLVType.DIRECT_NEIGHBORS)).toBe(true);
        
        const neighbors = TLV.decodeNeighbors(decodedMap.get(TLVType.DIRECT_NEIGHBORS)!);
        expect(neighbors.length).toBe(2);
        expect(neighbors[0]).toEqual(p1);
        expect(neighbors[1]).toEqual(p2);
    });

    it('should handle combined TLVs (Announce Payload)', () => {
        const nickname = "Bob";
        const neighbors = [new Uint8Array(8).fill(9)];
        
        const tlv1 = TLV.encodeNickname(nickname);
        const tlv2 = TLV.encodeNeighbors(neighbors);
        
        // Combine them
        const payload = new Uint8Array(tlv1.length + tlv2.length);
        payload.set(tlv1, 0);
        payload.set(tlv2, tlv1.length);
        
        const decodedMap = TLV.decode(payload);
        
        expect(decodedMap.size).toBe(2);
        expect(TLV.decodeNickname(decodedMap.get(TLVType.NICKNAME)!)).toBe(nickname);
        expect(TLV.decodeNeighbors(decodedMap.get(TLVType.DIRECT_NEIGHBORS)!).length).toBe(1);
    });
});
