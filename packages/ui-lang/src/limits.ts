/**
 * The sizes a ```ui block may reach. The compile-time ones (source, nodes,
 * depth) are checked while parsing; the rest are checked while it runs, so a
 * block can't fill the page, the state or a turn it sends. All are generous
 * for what a block is for: a small piece of interface in a message.
 */

/** How long a block's source may be. */
export const MAX_SOURCE_BYTES = 64 * 1024;
/** How many nodes its tree may have. */
export const MAX_NODES = 2000;
/** How deep its elements and blocks may nest. */
export const MAX_DEPTH = 24;
/** How large the block's state may be, as JSON. */
export const MAX_STATE_BYTES = 32 * 1024;
/** How long one text value in it may be, characters. */
export const MAX_TEXT_CHARS = 2000;
/** How long the turn a form sends may be. */
export const MAX_TURN_BYTES = 16 * 1024;
/** How much of a block's other state (sliders, checkboxes, declared values) a form's turn carries, as JSON. */
export const MAX_RESPONSE_STATE_BYTES = 4 * 1024;
/** How many steps one evaluation of a block may take. */
export const STEP_BUDGET = 50_000;
/** How many points a chart may draw. */
export const MAX_CHART_POINTS = 200;
