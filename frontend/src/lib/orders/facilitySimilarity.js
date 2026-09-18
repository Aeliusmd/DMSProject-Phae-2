import { normalizeForMatch } from "@/lib/orders/extractionFormUtils";

const DEFAULT_MIN_SCORE = 0.8;
const DEFAULT_LIMIT = 5;

function getFacilityLabel(facility) {
  return facility?.facility || facility?.facilityName || facility?.name || "";
}

/**
 * Dice coefficient on character bigrams (same idea as string-similarity).
 * Does not strip legal suffixes (LLC, Inc, etc.) — full normalized text is compared.
 */
export function compareFacilityNames(a, b) {
  const left = normalizeForMatch(a);
  const right = normalizeForMatch(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0;
  }

  const bigrams = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) || 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      intersection += 1;
    }
  }

  return (2 * intersection) / (left.length - 1 + (right.length - 1));
}

/**
 * Rank facilities by name similarity to an extracted/query name.
 * @returns {{ facility: object, score: number, percent: number }[]}
 */
export function findSimilarFacilities(
  queryName,
  facilityList = [],
  { minScore = DEFAULT_MIN_SCORE, limit = DEFAULT_LIMIT, excludeId = null } = {}
) {
  const query = `${queryName || ""}`.trim();
  if (!query || !Array.isArray(facilityList) || !facilityList.length) {
    return [];
  }

  const exclude = excludeId != null && `${excludeId}`.trim() !== ""
    ? String(excludeId)
    : null;

  const scored = [];
  for (const facility of facilityList) {
    if (!facility) continue;
    if (exclude && String(facility.id) === exclude) continue;

    const label = getFacilityLabel(facility);
    if (!label) continue;

    const score = compareFacilityNames(query, label);
    if (score >= minScore) {
      scored.push({
        facility,
        score,
        percent: Math.round(score * 1000) / 10,
      });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(getFacilityLabel(a.facility)).localeCompare(
      String(getFacilityLabel(b.facility))
    );
  });

  return scored.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
}
