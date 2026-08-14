export const PANE_LAYOUT_LIMITS = {
  leftMinimum: 220,
  leftMaximum: 520,
  rightMinimum: 340,
  rightMaximum: 720,
  centerMinimum: 360,
  splitterTotal: 8,
} as const;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

export function clampPaneWidths(totalWidth: number, requestedLeft: number, requestedRight: number): { left: number; right: number } {
  const limits = PANE_LAYOUT_LIMITS;
  const total = Math.max(0, finite(totalWidth, 0));
  const leftMaximum = Math.min(
    limits.leftMaximum,
    total - limits.rightMinimum - limits.centerMinimum - limits.splitterTotal,
  );
  const left = clamp(finite(requestedLeft, limits.leftMinimum), limits.leftMinimum, leftMaximum);
  const rightMaximum = Math.min(
    limits.rightMaximum,
    total - left - limits.centerMinimum - limits.splitterTotal,
  );
  const right = clamp(finite(requestedRight, limits.rightMinimum), limits.rightMinimum, rightMaximum);
  return { left, right };
}

export function clampDraggedPaneWidth(
  totalWidth: number,
  side: 'left' | 'right',
  proposedWidth: number,
  oppositeWidth: number,
): number {
  const limits = PANE_LAYOUT_LIMITS;
  const minimum = side === 'left' ? limits.leftMinimum : limits.rightMinimum;
  const maximum = side === 'left' ? limits.leftMaximum : limits.rightMaximum;
  const available = finite(totalWidth, 0)
    - finite(oppositeWidth, side === 'left' ? limits.rightMinimum : limits.leftMinimum)
    - limits.centerMinimum
    - limits.splitterTotal;
  return clamp(finite(proposedWidth, minimum), minimum, Math.min(maximum, available));
}
