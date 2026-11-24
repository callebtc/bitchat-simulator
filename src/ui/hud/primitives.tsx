import React from 'react';

import { usePersistedState } from '../../utils/usePersistedState';

/**
 * Shared HUD design primitives so every panel (left control rail, inspector,
 * bottom console, phone dock) uses one visual language:
 *  - glass cards: slate-950/75, 16px radius, hairline white/10 border
 *  - section headers: 10px semibold uppercase, wide tracking, slate-400
 *  - values: monospace, tabular numerals; labels: system sans
 *  - accent: cyan for primary/active, semantic colours for state
 */

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

export const GLASS =
    'bg-slate-950/75 backdrop-blur-xl border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.45)]';

export const HudPanel: React.FC<{
    className?: string;
    style?: React.CSSProperties;
    children: React.ReactNode;
}> = ({ className, style, children }) => (
    <div
        className={cx(GLASS, 'pointer-events-auto flex flex-col rounded-2xl font-sans text-slate-200', className)}
        style={style}
    >
        {children}
    </div>
);

const Chevron: React.FC<{ open: boolean }> = ({ open }) => (
    <svg
        width="9"
        height="9"
        viewBox="0 0 10 6"
        fill="none"
        className={cx('transition-transform duration-200', open ? 'rotate-0' : '-rotate-90')}
    >
        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/** Collapsible panel section with a consistent header. */
export const Section: React.FC<{
    title: string;
    icon?: React.ReactNode;
    /** Compact summary shown in the header (also visible when collapsed). */
    meta?: React.ReactNode;
    persistKey?: string;
    defaultOpen?: boolean;
    children: React.ReactNode;
    className?: string;
}> = ({ title, icon, meta, persistKey, defaultOpen = true, children, className }) => {
    const [open, setOpen] = usePersistedState(persistKey ?? `section_${title}`, defaultOpen);
    return (
        <div className={cx('border-t border-white/[0.06]', className)}>
            <button
                onClick={() => setOpen(!open)}
                className="group flex w-full items-center gap-2 px-3 py-2 text-left"
            >
                <span className="text-slate-500 transition-colors group-hover:text-slate-300">
                    <Chevron open={open} />
                </span>
                {icon && <span className="text-slate-500">{icon}</span>}
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 transition-colors group-hover:text-slate-200">
                    {title}
                </span>
                {meta && <span className="ml-auto truncate font-mono text-[10px] text-slate-500">{meta}</span>}
            </button>
            {open && <div className="px-3 pb-3">{children}</div>}
        </div>
    );
};

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    disabled,
    size = 'sm',
    className,
}: {
    options: ReadonlyArray<{ id: T; label: React.ReactNode; hint?: string }>;
    value: T;
    onChange: (v: T) => void;
    disabled?: (v: T) => boolean;
    size?: 'xs' | 'sm';
    className?: string;
}): React.ReactElement {
    return (
        <div className={cx('flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.08]', className)}>
            {options.map(o => {
                const on = o.id === value;
                const off = disabled?.(o.id) ?? false;
                return (
                    <button
                        key={o.id}
                        title={o.hint}
                        disabled={off}
                        onClick={() => onChange(o.id)}
                        className={cx(
                            'flex-1 rounded-md font-medium transition-all',
                            size === 'xs' ? 'px-1.5 py-[3px] text-[10px]' : 'px-2 py-1 text-[11px]',
                            on
                                ? 'bg-cyan-400/15 text-cyan-100 shadow-[0_0_10px_rgba(34,211,238,0.18)] ring-1 ring-cyan-300/35'
                                : off
                                  ? 'cursor-not-allowed text-slate-600'
                                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

export const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; tone?: 'cyan' | 'amber' | 'violet' }> = ({
    on,
    onChange,
    tone = 'cyan',
}) => {
    const bg = tone === 'amber' ? 'bg-amber-500' : tone === 'violet' ? 'bg-violet-500' : 'bg-cyan-500';
    return (
        <button
            role="switch"
            aria-checked={on}
            onClick={() => onChange(!on)}
            className={cx('relative h-[16px] w-[28px] shrink-0 rounded-full transition-colors', on ? bg : 'bg-white/10')}
        >
            <span
                className={cx(
                    'absolute left-0 top-[2px] h-3 w-3 rounded-full bg-white shadow transition-transform',
                    on ? 'translate-x-[14px]' : 'translate-x-[2px]'
                )}
            />
        </button>
    );
};

/** Label + control on one dense row. */
export const Row: React.FC<{ label: React.ReactNode; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="flex items-center justify-between gap-2 py-1" title={hint}>
        <span className="text-[11px] text-slate-400">{label}</span>
        {children}
    </div>
);

/** Small on/off chip (used for layer toggles in a grid). */
export const ToggleChip: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string; color?: string }> = ({
    on,
    onChange,
    label,
    color = '#22d3ee',
}) => (
    <button
        onClick={() => onChange(!on)}
        className={cx(
            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors',
            on ? 'border-white/10 bg-white/[0.06] text-slate-100' : 'border-white/[0.04] bg-transparent text-slate-500 hover:text-slate-300'
        )}
    >
        <span
            className="h-1.5 w-1.5 shrink-0 rounded-full transition-all"
            style={{ backgroundColor: on ? color : 'rgba(148,163,184,0.35)', boxShadow: on ? `0 0 6px ${color}` : 'none' }}
        />
        <span className="truncate">{label}</span>
    </button>
);

/** Compact KPI tile. */
export const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }> = ({
    label,
    value,
    sub,
    tone = 'text-slate-100',
}) => (
    <div className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/[0.05]">
        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</div>
        <div className={cx('mt-0.5 truncate font-mono text-[15px] font-semibold leading-none tabular-nums', tone)}>{value}</div>
        {sub && <div className="mt-1 truncate font-mono text-[9px] text-slate-500">{sub}</div>}
    </div>
);

type ButtonTone = 'primary' | 'ghost' | 'danger' | 'amber';
const BUTTON_TONES: Record<ButtonTone, string> = {
    primary: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20',
    ghost: 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07] hover:text-white',
    danger: 'border-rose-400/25 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
    amber: 'border-amber-400/25 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20',
};

export const HudButton: React.FC<
    React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; small?: boolean }
> = ({ tone = 'ghost', small, className, children, ...rest }) => (
    <button
        {...rest}
        className={cx(
            'rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
            BUTTON_TONES[tone],
            className
        )}
    >
        {children}
    </button>
);

/** Inline SVG icons (stroke = currentColor). */
export const Icon = {
    eye: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    ),
    layers: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2 2 7l10 5 10-5-10-5z" />
            <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
        </svg>
    ),
    users: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    ),
    pin: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2.5a7 7 0 017 7C19 14.8 12 21 12 21z" />
            <circle cx="12" cy="9.5" r="2.5" />
        </svg>
    ),
    chart: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 20V10M12 20V4M6 20v-6" />
        </svg>
    ),
    phone: (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="2" width="12" height="20" rx="3" />
            <path d="M11 18h2" />
        </svg>
    ),
};
