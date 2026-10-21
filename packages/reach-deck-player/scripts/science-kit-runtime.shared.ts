export type ScienceKitController = Readonly<{
  reset: () => void;
  destroy: () => void;
  getState: () => unknown;
  setState: (state: unknown) => boolean;
}>;

export type ScienceKitMount = (
  target: HTMLElement,
  spec: Readonly<Record<string, unknown>>,
) => ScienceKitController;

declare global {
  interface Window {
    __reachScienceKitFacades?: Record<string, Readonly<{ mount: ScienceKitMount }>>;
  }
}

export const COLORS = Object.freeze({
  ink: '#172033',
  muted: '#64748b',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#d97706',
});

export function color(value: unknown): string {
  return COLORS[String(value) as keyof typeof COLORS] ?? COLORS.accent;
}

export function registerScienceKit(runtimeId: string, mount: ScienceKitMount): void {
  const registry = window.__reachScienceKitFacades ?? Object.create(null);
  if (window.__reachScienceKitFacades === undefined) {
    Object.defineProperty(window, '__reachScienceKitFacades', {
      value: registry,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
  if (registry[runtimeId] !== undefined) throw new Error(`Duplicate science kit ${runtimeId}.`);
  registry[runtimeId] = Object.freeze({ mount });
}

export function fillTarget(target: HTMLElement, ariaLabel: unknown): void {
  target.replaceChildren();
  target.setAttribute('role', 'application');
  target.setAttribute('aria-label', String(ariaLabel));
  Object.assign(target.style, {
    width: '100%',
    height: '100%',
    minHeight: '0',
    overflow: 'hidden',
    position: 'relative',
  });
}

export const frozenController = (
  reset: () => void,
  destroy: () => void,
  getState: () => unknown = () => null,
  setState: (state: unknown) => boolean = () => false,
): ScienceKitController => Object.freeze({ reset, destroy, getState, setState });
