import { useEffect, useState } from 'react';

import { useSimulation } from '../../context/SimulationContext';
import { Building, MapContext } from '../../../simulation/environment';

export interface EnvironmentSnapshot {
    buildings: Building[];
    mapContext: MapContext;
    /** Increments every time the environment is (re)loaded or cleared. */
    version: number;
}

/** Subscribes to `environment_loaded` / `reset` and returns immutable environment data. */
export function useEnvironmentSnapshot(): EnvironmentSnapshot {
    const engine = useSimulation();
    const [snapshot, setSnapshot] = useState<EnvironmentSnapshot>(() => ({
        buildings: engine.environment.getBuildings(),
        mapContext: engine.environment.getMapContext(),
        version: 0,
    }));

    useEffect(() => {
        const refresh = () =>
            setSnapshot(prev => ({
                buildings: [...engine.environment.getBuildings()],
                mapContext: engine.environment.getMapContext(),
                version: prev.version + 1,
            }));
        engine.events.on('environment_loaded', refresh);
        engine.events.on('reset', refresh);
        return () => {
            engine.events.off('environment_loaded', refresh);
            engine.events.off('reset', refresh);
        };
    }, [engine]);

    return snapshot;
}
