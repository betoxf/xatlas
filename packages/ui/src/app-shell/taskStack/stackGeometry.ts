/** Cards visible in a project's stack; any further back are parked, unseen. */
export const TILE_STACK_DEPTH = 5;
/** How far each card behind peeks out above the one in front (px). */
export const STACK_LIFT_PX = 23;
export const STACK_LIFT_HOVER_PX = 27;

/** A card's place in its stack: lifted, shrunk and faded by its depth. */
export function stackDepthPose(index: number, lift = STACK_LIFT_PX) {
  const depth = Math.min(index, TILE_STACK_DEPTH - 1);
  const parked = index > TILE_STACK_DEPTH - 1;
  return {
    depth,
    parked,
    y: -depth * lift,
    scale: 1 - depth * 0.05,
    opacity: parked ? 0 : 1 - depth * 0.19,
  };
}

/**
 * The same place for a card that scales from its centre (as fanned cards do),
 * where stack cards scale from their top edge.
 */
export function centredStackDepthPose(index: number, cardHeight: number) {
  const pose = stackDepthPose(index);
  return { ...pose, y: pose.y - (cardHeight * (1 - pose.scale)) / 2 };
}
