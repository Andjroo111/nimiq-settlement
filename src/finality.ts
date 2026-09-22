// Albatross finality.
//
// A confirmation count is NOT finality on Albatross. Blocks are produced every
// second inside a batch, and the batch is only settled by the macro block that
// closes it. Counting N blocks deep answers "how long ago" and says nothing
// about whether the batch holding the tx has been committed, so a settlement
// gate built on a count can report money as paid and then watch it unwind.
//
// The correct question is: has the macro block AFTER the tx's block been
// produced? That is what `getMacroBlockAfter` answers on the node, and what
// `macroBlockAfter()` computes locally from policy.
//
// Two paths, and they must agree:
//   - macroBlockAfter(height)  pure policy math, no network, the test oracle.
//   - createFinalityGate(...)  asks the node once per tx, then re-polls only
//                              the head. The node is authoritative; the math
//                              is the fallback when the node omits the answer.

/** Micro blocks per batch. A macro block closes each batch. */
export const BLOCKS_PER_BATCH = 60;

/** Batches per epoch. An election macro block closes each epoch. */
export const BATCHES_PER_EPOCH = 32;

/** How far ahead of head a transaction may declare validityStartHeight. */
export const TX_VALIDITY_WINDOW_BLOCKS = 7200;

/**
 * Per-network constants. `genesisBlock` is the Albatross genesis HEIGHT, which
 * is not 0: the PoS chain starts at the block where it took over from PoW, and
 * a network proof that reads "block 0" reads the wrong thing.
 */
export const NETWORKS = {
  main: { id: 24, name: "MainAlbatross", genesisBlock: 3_456_000 },
  test: { id: 5, name: "TestAlbatross", genesisBlock: 3_032_010 },
} as const;

export type NetworkName = keyof typeof NETWORKS;

/**
 * Three-state settlement truth.
 *
 * `observed`  the tx was seen but there is no chain context to judge it by
 *             (no block number yet, or no head). Never treat as money moved.
 * `pending`   included in a block whose batch has not been closed by a macro
 *             block yet. Still reversible.
 * `final`     the macro block after the tx's block exists. Settled.
 */
export type FinalityState = "observed" | "pending" | "final";

const isHeight = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** The macro block at or below `height` (equals `height` when it is one). */
export function lastMacroBlock(height: number): number {
  if (!isHeight(height)) throw new TypeError(`lastMacroBlock: bad height ${height}`);
  return Math.floor(height / BLOCKS_PER_BATCH) * BLOCKS_PER_BATCH;
}

/**
 * The first macro block STRICTLY after `height`.
 *
 * Note the deliberate conservatism: when `height` is itself a macro block, the
 * answer is the NEXT one, a full batch later. A tx landing in a macro block is
 * arguably settled by that block, but "after" is what the node's
 * `getMacroBlockAfter` means and erring late is the only safe direction for a
 * gate that decides whether money moved.
 */
export function macroBlockAfter(height: number): number {
  return lastMacroBlock(height) + BLOCKS_PER_BATCH;
}

/** True when `height` closes a batch. */
export function isMacroBlock(height: number): boolean {
  return isHeight(height) && height % BLOCKS_PER_BATCH === 0;
}

/** True when `height` closes an epoch (an election macro block). */
export function isElectionBlock(height: number): boolean {
  return isMacroBlock(height) && (height / BLOCKS_PER_BATCH) % BATCHES_PER_EPOCH === 0;
}

/** The batch number `height` belongs to. */
export function batchOf(height: number): number {
  if (!isHeight(height)) throw new TypeError(`batchOf: bad height ${height}`);
  return Math.ceil(height / BLOCKS_PER_BATCH);
}

/**
 * Blocks still to be produced before the tx is final. 0 once it is.
 * Returns null when there is no chain context to measure against.
 */
export function blocksUntilFinal(
  txBlockNumber: number | null | undefined,
  headNumber: number | null | undefined,
): number | null {
  if (!isHeight(txBlockNumber) || !isHeight(headNumber)) return null;
  return Math.max(0, macroBlockAfter(txBlockNumber) - headNumber);
}

/**
 * The settlement verdict.
 *
 * No explicit "head is behind the tx" guard is needed: `macroBlockAfter(h) > h`
 * always, so a head below the tx can never satisfy the target and resolves to
 * `pending` on its own. A guard there would be unreachable, and an unreachable
 * guard is a comfort no test can defend.
 */
export function finalityState(
  txBlockNumber: number | null | undefined,
  headNumber: number | null | undefined,
): FinalityState {
  if (!isHeight(txBlockNumber) || !isHeight(headNumber)) return "observed";
  return headNumber >= macroBlockAfter(txBlockNumber) ? "final" : "pending";
}

/** Minimal node surface the gate needs. Both calls may be unavailable. */
export interface FinalityRpc {
  /** `getMacroBlockAfter` — the node's own answer, authoritative when present. */
  getMacroBlockAfter(height: number): Promise<{ number?: number } | number | null>;
  /** `getLatestBlock` — only the height is used. */
  getHeadNumber(): Promise<number | null>;
}

export interface FinalityGateOptions {
  rpc: FinalityRpc;
  /**
   * Fall back to `macroBlockAfter()` when the node cannot answer. Default true.
   * Set false to make an unanswerable node resolve `observed` rather than be
   * judged by local math.
   */
  localFallback?: boolean;
  logger?: { warn: (...a: unknown[]) => void };
}

export interface FinalityGate {
  /**
   * The macro block a tx at `txBlockNumber` must wait for. Asked of the node
   * once per height, then cached: the target cannot move, only the head does.
   */
  targetFor(txBlockNumber: number): Promise<number | null>;
  /** The verdict right now, re-polling only the head. */
  stateOf(txBlockNumber: number | null | undefined): Promise<FinalityState>;
  /** Convenience: true only on `final`. */
  isFinal(txBlockNumber: number | null | undefined): Promise<boolean>;
  /** Drop cached targets below `height` so a long-lived gate does not grow. */
  prune(height: number): void;
}

const heightOf = (r: { number?: number } | number | null): number | null => {
  if (typeof r === "number") return isHeight(r) ? r : null;
  if (r && isHeight(r.number)) return r.number;
  return null;
};

export function createFinalityGate(opts: FinalityGateOptions): FinalityGate {
  const { rpc, localFallback = true, logger } = opts;
  const targets = new Map<number, number>();

  const targetFor = async (txBlockNumber: number): Promise<number | null> => {
    if (!isHeight(txBlockNumber)) return null;
    const cached = targets.get(txBlockNumber);
    if (cached !== undefined) return cached;

    let target: number | null = null;
    try {
      target = heightOf(await rpc.getMacroBlockAfter(txBlockNumber));
    } catch (e) {
      logger?.warn(`getMacroBlockAfter(${txBlockNumber}) failed`, e);
    }

    // A node that answers with a macro block at or below the tx is wrong about
    // "after"; distrust it rather than settle early on its arithmetic.
    if (target !== null && target <= txBlockNumber) {
      logger?.warn(`getMacroBlockAfter(${txBlockNumber}) returned ${target}, ignoring`);
      target = null;
    }
    if (target === null && localFallback) target = macroBlockAfter(txBlockNumber);
    if (target !== null) targets.set(txBlockNumber, target);
    return target;
  };

  const stateOf = async (txBlockNumber: number | null | undefined): Promise<FinalityState> => {
    if (!isHeight(txBlockNumber)) return "observed";
    const target = await targetFor(txBlockNumber);
    if (target === null) return "observed";

    let head: number | null = null;
    try {
      head = await rpc.getHeadNumber();
    } catch (e) {
      logger?.warn("getHeadNumber failed", e);
    }
    if (!isHeight(head)) return "observed";
    // Same invariant as finalityState: every accepted target is > txBlockNumber.
    return head >= target ? "final" : "pending";
  };

  return {
    targetFor,
    stateOf,
    isFinal: async (n) => (await stateOf(n)) === "final",
    prune: (height) => {
      for (const k of targets.keys()) if (k < height) targets.delete(k);
    },
  };
}
