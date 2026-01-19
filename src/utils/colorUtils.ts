// Deterministic color generation from Peer ID
export function getPeerColor(peerId: string): string {
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
        hash = peerId.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // HSL:
    // Hue: Hash % 360
    // Saturation: 70-90%
    // Lightness: 50-60%
    
    const h = Math.abs(hash % 360);
    const s = 70 + (Math.abs(hash) % 20); 
    const l = 50 + (Math.abs(hash) % 10);
    
    return `hsl(${h}, ${s}%, ${l}%)`;
}
