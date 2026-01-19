import { describe, it, expect } from 'vitest';
import { BinaryProtocol } from '../BinaryProtocol';
import { createPacket, MessageType } from '../BitchatPacket';

describe('BinaryProtocol', () => {
    it('should encode and decode a basic packet correctly', () => {
        const senderID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);
        
        const packet = createPacket(MessageType.MESSAGE, senderID, payload);
        
        const encoded = BinaryProtocol.encode(packet);
        expect(encoded).not.toBeNull();
        
        if (encoded) {
            const decoded = BinaryProtocol.decode(encoded);
            expect(decoded).not.toBeNull();
            
            if (decoded) {
                expect(decoded.version).toBe(1);
                expect(decoded.type).toBe(MessageType.MESSAGE);
                expect(decoded.ttl).toBe(7);
                // SenderID check
                expect(decoded.senderID).toEqual(senderID);
                // Payload check
                expect(decoded.payload).toEqual(payload);
                // Timestamp should match (ignoring precision loss if any, but BigInt should be exact)
                expect(decoded.timestamp).toBe(packet.timestamp);
            }
        }
    });

    it('should handle packets with recipientID', () => {
        const senderID = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
        const recipientID = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);
        const payload = new Uint8Array([0x00]);
        
        const packet = createPacket(MessageType.MESSAGE, senderID, payload, 7, recipientID);
        
        const encoded = BinaryProtocol.encode(packet);
        expect(encoded).not.toBeNull();
        
        const decoded = BinaryProtocol.decode(encoded!);
        expect(decoded).not.toBeNull();
        expect(decoded?.recipientID).toEqual(recipientID);
    });

    it('should fail on too short data', () => {
        const tooShort = new Uint8Array([1, 1, 1]); // definitely < Header size
        const decoded = BinaryProtocol.decode(tooShort);
        expect(decoded).toBeNull();
    });
});
