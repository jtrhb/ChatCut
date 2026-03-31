/**
 * CandidateGenerator — Jaccard-based overlap and dispersion utilities
 * for the fan-out exploration system.
 */
export class CandidateGenerator {
  /**
   * Calculate Jaccard similarity between two candidate result timelines.
   * Returns a value between 0.0 (no overlap) and 1.0 (identical).
   */
  calculateOverlap(
    candidateA: { resultTimeline: { elements: string[] } },
    candidateB: { resultTimeline: { elements: string[] } }
  ): number {
    const setA = new Set(candidateA.resultTimeline.elements);
    const setB = new Set(candidateB.resultTimeline.elements);

    if (setA.size === 0 && setB.size === 0) {
      return 1.0;
    }

    let intersectionSize = 0;
    for (const id of setA) {
      if (setB.has(id)) intersectionSize++;
    }

    const unionSize = setA.size + setB.size - intersectionSize;
    if (unionSize === 0) return 0;

    return intersectionSize / unionSize;
  }

  /**
   * Validate that all pairs of candidates have an overlap below 0.7.
   * Returns true if every pair's Jaccard similarity is <= 0.7, false otherwise.
   */
  validateDispersion(
    candidates: Array<{ resultTimeline: { elements: string[] } }>
  ): boolean {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const overlap = this.calculateOverlap(candidates[i]!, candidates[j]!);
        if (overlap > 0.7) {
          return false;
        }
      }
    }
    return true;
  }
}
