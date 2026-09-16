/** DeepSeek Harness plugin: automatic long-term memory via a NylonME engine. */
import type { Context } from '@deepseek-ai/cordis';

/** Cordis plugin name (also the patch row id convention). */
export declare const name: 'nylonme-memory';

export interface NylonmeMemoryConfig {
  /** NylonME HTTP REST base URL, e.g. `http://127.0.0.1:50052`. */
  url?: string;
  /** Engine API key (sent as `x-api-key`) when auth is enabled. */
  apiKey?: string;
  /** Tenant id passed to the engine (default `"default"`). */
  tenant?: string;
  /** Explicit owner override; empty derives the owner from the workspace slug. */
  owner?: string;
  /** Resonate at session start and inject recalled context (default true). */
  autoRecall?: boolean;
  /** WeaveSession at session end (default true). */
  autoWeave?: boolean;
  /** Resonance activation budget (default 8). */
  recallBudget?: number;
  /** Optional max graph hops for resonance. */
  recallMaxHops?: number;
  /** Cap on the recall query text (chars, default 2000). */
  recallQueryMaxChars?: number;
  /** Cap on the injected recall text (chars, default 4000). */
  recallRenderMaxChars?: number;
  /** Skip weaving sessions whose collected text is shorter (chars, default 200). */
  weaveMinChars?: number;
  /** Max events sent per weave, most recent kept (default 400). */
  weaveMaxEvents?: number;
  /** Also weave subagent-child sessions (default false). */
  weaveSubagents?: boolean;
  /** Ask the engine to skip the LLM abstract layer (default false). */
  weaveSkipAbstract?: boolean;
  /** HTTP timeout in ms (default 20000). */
  timeoutMs?: number;
  /** User-Agent header for engine requests. */
  userAgent?: string;
}

export declare function apply(ctx: Context, config?: NylonmeMemoryConfig): void;
