import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchBuildingsFromOSM } from '../OSMFetcher';

// Mock localStorage
const localStorageMock = (function() {
    let store: Record<string, string> = {};
    return {
        getItem: vi.fn((key: string) => store[key] || null),
        setItem: vi.fn((key: string, value: string) => {
            store[key] = value.toString();
        }),
        removeItem: vi.fn((key: string) => {
            delete store[key];
        }),
        clear: vi.fn(() => {
            store = {};
        }),
        key: vi.fn((i: number) => Object.keys(store)[i] || null),
        get length() {
            return Object.keys(store).length;
        }
    };
})();

Object.defineProperty(global, 'localStorage', {
    value: localStorageMock
});

// Mock fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('OSMFetcher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorageMock.clear();
    });

    it('should try mirrors if first one fails', async () => {
        // First call fails
        fetchMock.mockImplementationOnce(() => Promise.reject(new Error('Network error')));
        // Second call succeeds
        fetchMock.mockImplementationOnce(() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
                elements: []
            })
        }));

        await fetchBuildingsFromOSM(0, 0, 0.01, 0.01, { useCache: false });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should try mirrors on 502/429 errors', async () => {
        // First call 502
        fetchMock.mockImplementationOnce(() => Promise.resolve({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway'
        }));
        // Second call 200
        fetchMock.mockImplementationOnce(() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
                elements: []
            })
        }));

        await fetchBuildingsFromOSM(0, 0, 0.01, 0.01, { useCache: false });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should report progress', async () => {
        const onProgress = vi.fn();
        
        fetchMock.mockImplementationOnce(() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
                elements: []
            })
        }));

        await fetchBuildingsFromOSM(0, 0, 0.01, 0.01, { useCache: false, onProgress });

        expect(onProgress).toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalledWith(expect.any(Number), expect.any(String));
    });

    it('should throw if all mirrors fail', async () => {
         fetchMock.mockImplementation(() => Promise.reject(new Error('Fail')));
         
         await expect(fetchBuildingsFromOSM(0, 0, 0.01, 0.01, { useCache: false }))
             .rejects.toThrow();
    });
});
