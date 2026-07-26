/*
 * The timeline was split into project/features/timeline/ (model, layout, view,
 * chrome, rail, lightbox). This module stays as the public entry point so
 * existing call sites — init.js and the `openTimeline()` button in ui/quiz.js —
 * keep working unchanged.
 */
export { openTimeline } from './timeline/index.js';
