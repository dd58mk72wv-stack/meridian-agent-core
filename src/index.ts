/**
 * @meridian/agent-core
 *
 * The shared core every Meridian client system is built on.
 *
 * Consumed by version tag rather than copied, so a fix lands once and each
 * client bumps. Client systems stay in their own repos with their own database
 * and their own Railway service — one client's change can never reach another.
 */

export * from './core/context.js';
export * from './core/agent.js';
export * from './core/manager.js';
export * from './core/cmo.js';
export * from './core/resolver.js';
export { log } from './core/logger.js';
export * from './core/db.js';
export * from './core/queue.js';
export * from './adapters/index.js';
export * from './voice/index.js';
