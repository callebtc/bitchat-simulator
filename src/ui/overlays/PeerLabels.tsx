import React, { useEffect, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useCamera } from '../context/CameraContext';
import { useVisualization } from '../context/VisualizationContext';
import { BitchatPerson } from '../../simulation/BitchatPerson';
import { getPeerColor } from '../../utils/colorUtils';
import { useScreenAnchor } from './ScreenAnchors';
import { useTerrain } from '../context/TerrainContext';

const LABEL_ALL_THRESHOLD = 60;

type Role = 'from' | 'to' | 'hover' | 'follow' | null;

const PeerLabel: React.FC<{ person: BitchatPerson; role: Role }> = ({ person, role }) => {
    const { heightAt } = useTerrain();
    const ref = useScreenAnchor(
        `label:${person.id}`,
        () => ({ x: person.position.x, y: person.position.y, z: 2.75 + heightAt(person.position.x, person.position.y) }),
        { maxDistance: role ? 3000 : 420 }
    );
    const color = getPeerColor(person.device.peerIDHex);
    const roleStyle =
        role === 'from'
            ? 'border-cyan-300/70 text-cyan-100'
            : role === 'to'
              ? 'border-fuchsia-400/70 text-fuchsia-100'
              : role === 'hover'
                ? 'border-amber-200/60 text-amber-50'
                : role === 'follow'
                  ? 'border-emerald-300/70 text-emerald-50'
                  : 'border-white/10 text-slate-200';
    return (
        <div ref={ref} className="absolute left-0 top-0 pb-1 will-change-transform" style={{ visibility: 'hidden' }}>
            <div
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border bg-slate-950/70 px-2 py-0.5 font-mono text-[10px] leading-4 shadow-lg backdrop-blur-sm ${roleStyle}`}
            >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
                {role === 'from' && <span className="font-bold text-cyan-300">FROM</span>}
                {role === 'to' && <span className="font-bold text-fuchsia-300">TO</span>}
                <span className="font-semibold">{person.device.nickname}</span>
                {role && <span className="text-slate-500">{person.device.peerIDHex.substring(0, 6)}</span>}
            </div>
        </div>
    );
};

/** Name tags above devices: everyone in small crowds, otherwise only focused devices. */
export const PeerLabels: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, highlightedId } = useSelection();
    const { followId } = useCamera();
    const { showLabels } = useVisualization();
    const [population, setPopulation] = useState(0);

    useEffect(() => {
        const sync = () => setPopulation(engine.getAllPeople().length);
        sync();
        engine.events.on('person_added', sync);
        engine.events.on('person_removed', sync);
        engine.events.on('reset', sync);
        return () => {
            engine.events.off('person_added', sync);
            engine.events.off('person_removed', sync);
            engine.events.off('reset', sync);
        };
    }, [engine]);

    const roles = new Map<string, Role>();
    if (selectedId && selectionType === 'node') roles.set(selectedId, 'from');
    const recipient = chatRecipientId ? engine.getPersonByPeerId(chatRecipientId) : undefined;
    if (recipient) roles.set(recipient.id, 'to');
    const hovered = highlightedId ? engine.getPersonByPeerId(highlightedId) : undefined;
    if (hovered && !roles.has(hovered.id)) roles.set(hovered.id, 'hover');
    if (followId && !roles.has(followId)) roles.set(followId, 'follow');

    const people: BitchatPerson[] = [];
    if (showLabels && population > 0 && population <= LABEL_ALL_THRESHOLD) {
        people.push(...engine.getAllPeople());
    } else {
        for (const id of roles.keys()) {
            const p = engine.getPerson(id);
            if (p) people.push(p);
        }
    }

    return (
        <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
            {people.map(p => (
                <PeerLabel key={p.id} person={p} role={roles.get(p.id) ?? null} />
            ))}
        </div>
    );
};
