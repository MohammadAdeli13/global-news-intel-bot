import type {
  AttributionConfidence,
  NewsCategory,
  OriginType,
} from "./types";

// ============================================================================
// 1. URL Canonicalization & SHA-256 Hashing
// ============================================================================

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "ocid",
  "cmpid",
  "taid",
  "ns_mchannel",
  "ns_source",
  "ns_campaign",
  "at_medium",
  "at_campaign",
  "s",
]);

export function canonicalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  parsed.hash = "";

  const keptParams: [string, string][] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith("utm_") || TRACKING_PARAMS.has(lowerKey)) {
      continue;
    }
    keptParams.push([key, value]);
  }
  keptParams.sort(([a], [b]) => a.localeCompare(b));

  parsed.search = "";
  for (const [key, value] of keptParams) {
    parsed.searchParams.append(key, value);
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

export async function computeUrlHash(canonicalUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// ============================================================================
// 2. Conservative Wire Agency Attribution Heuristic (Publisher Independence)
// ============================================================================

export interface OriginAttributionResult {
  effectiveOriginKey: string;
  originType: OriginType;
  attributionConfidence: AttributionConfidence;
  detectedWireName: string | null;
}

interface WirePattern {
  key: string;
  authorRegex: RegExp;
  strongTextRegex: RegExp;
  mediumTextRegex: RegExp;
}

const WIRE_PATTERNS: readonly WirePattern[] = [
  {
    key: "reuters",
    authorRegex: /\breuters\b/i,
    strongTextRegex: /(\(\s*reuters\s*\)|(?:—|–|-|\|)\s*reuters\b|\bvia\s+reuters\b|\bby\s+reuters\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by|cited\s+by)\s+reuters\b|\breuters\s+(?:reports|reported)\b/i,
  },
  {
    key: "ap",
    authorRegex: /\b(?:associated\s+press|ap\s+news)\b|^ap$/i,
    strongTextRegex: /(\(\s*(?:ap|associated\s+press)\s*\)|(?:—|–|-|\|)\s*(?:ap|associated\s+press)\b|\bvia\s+(?:ap|associated\s+press)\b|\bby\s+associated\s+press\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by)\s+(?:the\s+)?associated\s+press\b|\b(?:ap|associated\s+press)\s+(?:reports|reported)\b/i,
  },
  {
    key: "afp",
    authorRegex: /\b(?:afp|agence\s+france[- ]presse)\b/i,
    strongTextRegex: /(\(\s*afp\s*\)|(?:—|–|-|\|)\s*afp\b|\bvia\s+afp\b|\bby\s+afp\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by)\s+afp\b|\bafp\s+(?:reports|reported)\b/i,
  },
  {
    key: "bloomberg",
    authorRegex: /\bbloomberg\b/i,
    strongTextRegex: /(\(\s*bloomberg\s*\)|(?:—|–|-|\|)\s*bloomberg\b|\bvia\s+bloomberg\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by)\s+bloomberg\b|\bbloomberg\s+(?:reports|reported)\b/i,
  },
  {
    key: "tass",
    authorRegex: /\btass\b/i,
    strongTextRegex: /(\(\s*tass\s*\)|(?:—|–|-|\|)\s*tass\b|\bvia\s+tass\b)/i,
    mediumTextRegex: /\b(?:according\s+to|cited\s+by)\s+tass\b|\btass\s+(?:reports|reported)\b/i,
  },
  {
    key: "xinhua",
    authorRegex: /\bxinhua\b/i,
    strongTextRegex: /(\(\s*xinhua\s*\)|(?:—|–|-|\|)\s*xinhua\b|\bvia\s+xinhua\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by)\s+xinhua\b|\bxinhua\s+(?:reports|reported)\b/i,
  },
  {
    key: "irna",
    authorRegex: /\birna\b/i,
    strongTextRegex: /(\(\s*irna\s*\)|(?:—|–|-|\|)\s*irna\b|\bvia\s+irna\b)/i,
    mediumTextRegex: /\b(?:according\s+to|reported\s+by)\s+irna\b|\birna\s+(?:reports|reported)\b/i,
  },
];

export function detectOriginAttribution(input: {
  title: string;
  summary: string | null;
  author: string | null;
  publisherGroup: string;
  isWireAgency?: boolean;
}): OriginAttributionResult {
  const normalizedGroup = input.publisherGroup.trim().toLowerCase();

  // If the feed itself belongs to a primary wire agency, unify its origin key with syndicated copies
  if (input.isWireAgency) {
    return {
      effectiveOriginKey: `wire:${normalizedGroup}`,
      originType: "publisher_group",
      attributionConfidence: "high",
      detectedWireName: normalizedGroup,
    };
  }

  const authorText = (input.author ?? "").trim();
  const leadText = `${input.title} ${(input.summary ?? "").slice(0, 280)}`;

  for (const wire of WIRE_PATTERNS) {
    if (authorText && wire.authorRegex.test(authorText)) {
      return {
        effectiveOriginKey: `wire:${wire.key}`,
        originType: "wire_heuristic",
        attributionConfidence: "high",
        detectedWireName: wire.key,
      };
    }
    if (wire.strongTextRegex.test(leadText)) {
      return {
        effectiveOriginKey: `wire:${wire.key}`,
        originType: "wire_heuristic",
        attributionConfidence: "high",
        detectedWireName: wire.key,
      };
    }
    if (wire.mediumTextRegex.test(leadText)) {
      return {
        effectiveOriginKey: `wire:${wire.key}`,
        originType: "wire_heuristic",
        attributionConfidence: "medium",
        detectedWireName: wire.key,
      };
    }
  }

  return {
    effectiveOriginKey: `pub:${normalizedGroup}`,
    originType: "publisher_group",
    attributionConfidence: "high",
    detectedWireName: null,
  };
}

// ============================================================================
// 3. 5-Dimensional Lightweight Story Feature Extraction & Clustering
// ============================================================================

export interface StoryFeatures {
  entities: string[];
  locations: string[];
  concepts: string[];
  titleTokens: string[];
  titleBigrams: string[];
  titleNumbers: string[];
}

export interface ClusterCandidate {
  id: number;
  primaryTitle: string;
  category: NewsCategory;
  entities: string[];
  locations: string[];
  concepts: string[];
  eventTime: number;
}

export interface ClusterMatchBreakdown {
  total: number;
  entityScore: number;
  titleScore: number;
  locationScore: number;
  conceptScore: number;
  timeScore: number;
  conflictPenalty: number;
  sharedEntities: number;
  matched: boolean;
}

const ENTITY_ALIASES: readonly [RegExp, string][] = [
  [/\b(?:u\.s\.a\.?|u\.s\.|united states|washington|pentagon|white house)\b/i, "usa"],
  [/\b(?:federal reserve|the fed|fed chair|fomc)\b/i, "fed"],
  [/\b(?:european central bank|ecb)\b/i, "ecb"],
  [/\b(?:bank of england|boe)\b/i, "boe"],
  [/\b(?:bank of japan|boj)\b/i, "boj"],
  [/\b(?:imf|international monetary fund)\b/i, "imf"],
  [/\b(?:world bank)\b/i, "world_bank"],
  [/\b(?:opec\+|opec)\b/i, "opec"],
  [/\b(?:nato|north atlantic treaty)\b/i, "nato"],
  [/\b(?:united nations|u\.n\.|un security council|unsc)\b/i, "un"],
  [/\b(?:iaea|atomic energy agency)\b/i, "iaea"],
  [/\b(?:who|world health organization)\b/i, "who"],
  [/\b(?:european union|eu commission|brussels)\b/i, "eu"],
  [/\b(?:israel|idf|israeli)\b/i, "israel"],
  [/\b(?:iran|iranian|tehran|irgc)\b/i, "iran"],
  [/\b(?:russia|russian|kremlin|moscow)\b/i, "russia"],
  [/\b(?:ukraine|ukrainian|kyiv|kiev)\b/i, "ukraine"],
  [/\b(?:china|chinese|beijing|pla)\b/i, "china"],
  [/\b(?:taiwan|taipei)\b/i, "taiwan"],
  [/\b(?:north korea|pyongyang|dprk)\b/i, "north_korea"],
  [/\b(?:south korea|seoul)\b/i, "south_korea"],
  [/\b(?:hamas)\b/i, "hamas"],
  [/\b(?:hezbollah)\b/i, "hezbollah"],
  [/\b(?:houthis?|ansar allah)\b/i, "houthi"],
  [/\b(?:isis|islamic state|daesh)\b/i, "isis"],
  [/\b(?:saudi arabia|riyadh|aramco)\b/i, "saudi_arabia"],
  [/\b(?:turkey|turkiye|ankara)\b/i, "turkey"],
  [/\b(?:syria|damascus)\b/i, "syria"],
  [/\b(?:lebanon|beirut)\b/i, "lebanon"],
  [/\b(?:yemen|sanaa)\b/i, "yemen"],
  [/\b(?:iraq|baghdad)\b/i, "iraq"],
  [/\b(?:india|new delhi)\b/i, "india"],
  [/\b(?:pakistan|islamabad)\b/i, "pakistan"],
  [/\b(?:britain|uk|united kingdom|london)\b/i, "uk"],
  [/\b(?:france|paris)\b/i, "france"],
  [/\b(?:germany|berlin)\b/i, "germany"],
  [/\b(?:japan|tokyo)\b/i, "japan"],
];

const LOCATION_ALIASES: readonly [RegExp, string][] = [
  [/\b(?:gaza|rafah|khan younis)\b/i, "gaza"],
  [/\b(?:west bank|jerusalem|tel aviv|haifa|israel)\b/i, "israel_palestine"],
  [/\b(?:beirut|southern lebanon|lebanon)\b/i, "lebanon"],
  [/\b(?:tehran|isfahan|natanz|fordow|iran)\b/i, "iran"],
  [/\b(?:strait of hormuz|persian gulf|hormuz)\b/i, "hormuz"],
  [/\b(?:red sea|bab el[- ]mandeb|aden|yemen)\b/i, "red_sea"],
  [/\b(?:kyiv|kiev|kharkiv|odesa|odessa|donbas|crimea|ukraine)\b/i, "ukraine"],
  [/\b(?:moscow|belgorod|kursk|russia)\b/i, "russia"],
  [/\b(?:black sea)\b/i, "black_sea"],
  [/\b(?:taiwan strait|south china sea|taipei|taiwan)\b/i, "taiwan_strait"],
  [/\b(?:beijing|shanghai|china)\b/i, "china"],
  [/\b(?:pyongyang|korean peninsula|north korea)\b/i, "korean_peninsula"],
  [/\b(?:damascus|aleppo|syria)\b/i, "syria"],
  [/\b(?:baghdad|erbil|iraq)\b/i, "iraq"],
  [/\b(?:sudan|khartoum)\b/i, "sudan"],
  [/\b(?:washington|new york|california|texas|united states|u\.s\.)\b/i, "usa"],
  [/\b(?:london|uk|britain)\b/i, "uk"],
  [/\b(?:brussels|paris|berlin|europe)\b/i, "europe"],
  [/\b(?:tokyo|japan)\b/i, "japan"],
  [/\b(?:india|new delhi|kashmir)\b/i, "india"],
  [/\b(?:pakistan|islamabad)\b/i, "pakistan"],
  [/\b(?:turkey|ankara|istanbul)\b/i, "turkey"],
  [/\b(?:saudi arabia|riyadh)\b/i, "saudi_arabia"],
];

const DOMAIN_CONCEPT_MAP: readonly [RegExp, string][] = [
  [
    /\b(?:missile|rockets?|ballistic|cruise missile|drone|uav|airstrike|air strike|bombardment|shelling|strike[sd]?)\b/i,
    "CONCEPT_STRIKE",
  ],
  [
    /\b(?:ceasefire|truce|peace talks|hostage deal|armistice)\b/i,
    "CONCEPT_CEASEFIRE",
  ],
  [
    /\b(?:invasion|offensive|ground operation|troops|mobilization|clashes|military operation|warships?)\b/i,
    "CONCEPT_MILITARY_OP",
  ],
  [
    /\b(?:retaliat(?:e|ion|ory)|counterattack|reprisal|response strike)\b/i,
    "CONCEPT_RETALIATION",
  ],
  [
    /\b(?:nuclear|uranium|enrichment|warhead|icbm|plutonium|reactor|iaea)\b/i,
    "CONCEPT_NUCLEAR",
  ],
  [
    /\b(?:sanctions?|asset freeze|export ban|embargo|tariffs?|blacklist)\b/i,
    "CONCEPT_SANCTION",
  ],
  [
    /\b(?:cyberattack|ransomware|hack(?:ed|ers|ing)?|data breach|ddos|grid outage|critical infrastructure)\b/i,
    "CONCEPT_CYBER",
  ],
  [
    /\b(?:oil|crude|brent|wti|lng|natural gas|pipeline|refinery|opec|energy crisis)\b/i,
    "CONCEPT_ENERGY",
  ],
  [
    /\b(?:interest rate|rate cut|rate hike|basis points|bps|inflation|monetary policy|quantitative tightening)\b/i,
    "CONCEPT_RATE",
  ],
  [
    /\b(?:recession|default|bank run|banking crisis|bailout|currency crash|sovereign debt|market crash)\b/i,
    "CONCEPT_FIN_CRISIS",
  ],
  [
    /\b(?:earthquake|magnitude|tsunami|hurricane|typhoon|wildfire|flood(?:ing|s)?|volcano|landslide)\b/i,
    "CONCEPT_DISASTER",
  ],
  [
    /\b(?:outbreak|epidemic|pandemic|virus|mpox|avian flu|h5n1|cholera|ebola|health emergency)\b/i,
    "CONCEPT_HEALTH",
  ],
  [
    /\b(?:election|referendum|coup|impeach(?:ment)?|resigns?|prime minister|president elected|parliament)\b/i,
    "CONCEPT_ELECTION",
  ],
  [
    /\b(?:terror(?:ism|ist)?|suicide bomb|mass shooting|hostage|explosive|extremist)\b/i,
    "CONCEPT_TERROR",
  ],
  [
    /\b(?:killed|dead|deaths|casualties|wounded|injured|fatalities|death toll)\b/i,
    "CONCEPT_CASUALTIES",
  ],
  [
    /\b(?:confirmed|officially announced|ministry confirmed|defense ministry said|statement confirmed)\b/i,
    "CONCEPT_OFFICIAL_CONFIRMATION",
  ],
];

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "for",
  "from", "has", "have", "had", "he", "her", "his", "in", "into", "is", "it",
  "its", "may", "more", "new", "not", "of", "on", "or", "over", "said", "says",
  "she", "that", "the", "their", "they", "this", "to", "under", "up", "was",
  "were", "who", "will", "with", "after", "amid", "before", "against", "about",
  "report", "reports", "news", "live", "update", "updates", "breaking",
]);

function stemLight(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

export function tokenizeTitle(title: string): {
  tokens: string[];
  bigrams: string[];
  numbers: string[];
} {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9.%-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rawWords = cleaned.split(" ");
  const tokens: string[] = [];
  const numbers: string[] = [];

  for (const w of rawWords) {
    if (!w) continue;
    if (/^\d+(?:\.\d+)?%?$/.test(w)) {
      numbers.push(w);
      tokens.push(w);
      continue;
    }
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    tokens.push(stemLight(w));
  }

  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a && b) {
      bigrams.push(`${a}_${b}`);
    }
  }

  return {
    tokens: [...new Set(tokens)],
    bigrams: [...new Set(bigrams)],
    numbers: [...new Set(numbers)],
  };
}

export function extractStoryFeatures(
  title: string,
  summary: string | null
): StoryFeatures {
  const combined = `${title} ${summary ?? ""}`;

  const entitySet = new Set<string>();
  for (const [regex, canonical] of ENTITY_ALIASES) {
    if (regex.test(combined)) {
      entitySet.add(canonical);
    }
  }

  // Extract additional non-initial capitalized proper nouns from title (e.g., leaders/cities/vessels)
  const titleWords = title.split(/\s+/);
  for (let i = 1; i < titleWords.length; i++) {
    const raw = (titleWords[i] ?? "").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (raw.length >= 4 && /^[A-Z][a-z]{3,}$/.test(raw)) {
      const lower = raw.toLowerCase();
      if (!STOPWORDS.has(lower)) {
        entitySet.add(`pn:${lower}`);
      }
    }
  }

  const locationSet = new Set<string>();
  for (const [regex, canonical] of LOCATION_ALIASES) {
    if (regex.test(combined)) {
      locationSet.add(canonical);
    }
  }

  const conceptSet = new Set<string>();
  for (const [regex, canonical] of DOMAIN_CONCEPT_MAP) {
    if (regex.test(combined)) {
      conceptSet.add(canonical);
    }
  }

  const { tokens, bigrams, numbers } = tokenizeTitle(title);

  return {
    entities: [...entitySet].slice(0, 20),
    locations: [...locationSet].slice(0, 12),
    concepts: [...conceptSet].slice(0, 12),
    titleTokens: tokens,
    titleBigrams: bigrams,
    titleNumbers: numbers,
  };
}

function diceSimilarity(a: readonly string[], b: readonly string[]): {
  score: number;
  shared: number;
} {
  if (a.length === 0 || b.length === 0) {
    return { score: 0, shared: 0 };
  }
  const setB = new Set(b);
  let shared = 0;
  for (const item of a) {
    if (setB.has(item)) shared++;
  }
  return {
    score: (2 * shared) / (a.length + b.length),
    shared,
  };
}

function computeTimeProximityScore(timeA: number, timeB: number): number {
  const diffHours = Math.abs(timeA - timeB) / (60 * 60 * 1000);
  if (diffHours <= 6) return 1.0;
  if (diffHours <= 18) {
    return 1.0 - ((diffHours - 6) / 12) * 0.5;
  }
  if (diffHours <= 36) {
    return 0.5 - ((diffHours - 18) / 18) * 0.35;
  }
  return 0;
}

export const CLUSTER_WINDOW_MS = 36 * 60 * 60 * 1000;
export const CLUSTER_DIRECT_THRESHOLD = 0.62;
export const CLUSTER_SECONDARY_THRESHOLD = 0.50;
export const LOCATION_CONFLICT_PENALTY = 0.25;

export function computeClusterMatchScore(
  article: {
    title: string;
    category?: NewsCategory;
    features: StoryFeatures;
    eventTime: number;
  },
  cluster: ClusterCandidate
): ClusterMatchBreakdown {
  const entitySim = diceSimilarity(article.features.entities, cluster.entities);
  const conceptSim = diceSimilarity(article.features.concepts, cluster.concepts);
  const locSim = diceSimilarity(article.features.locations, cluster.locations);

  const clusterTitle = tokenizeTitle(cluster.primaryTitle);
  const unigramSim = diceSimilarity(
    article.features.titleTokens,
    clusterTitle.tokens
  );
  const bigramSim = diceSimilarity(
    article.features.titleBigrams,
    clusterTitle.bigrams
  );
  const numberSim = diceSimilarity(
    article.features.titleNumbers,
    clusterTitle.numbers
  );

  // Weighted title score: unigrams + bigrams + bonus for matching exact figures
  const titleScore = Math.min(
    1,
    0.65 * unigramSim.score + 0.25 * bigramSim.score + 0.15 * numberSim.score
  );

  const timeScore = computeTimeProximityScore(
    article.eventTime,
    cluster.eventTime
  );

  // Conflict penalty when both specify explicit locations with zero overlap
  const conflictPenalty =
    article.features.locations.length > 0 &&
    cluster.locations.length > 0 &&
    locSim.shared === 0
      ? LOCATION_CONFLICT_PENALTY
      : 0;

  const rawTotal =
    0.30 * entitySim.score +
    0.25 * titleScore +
    0.15 * locSim.score +
    0.15 * conceptSim.score +
    0.15 * timeScore -
    conflictPenalty;

  const total = Math.max(0, Math.min(1, rawTotal));

  const sameCategory =
    article.category === undefined || article.category === cluster.category;

  const matched =
    total >= CLUSTER_DIRECT_THRESHOLD ||
    (total >= CLUSTER_SECONDARY_THRESHOLD &&
      entitySim.shared >= 2 &&
      sameCategory &&
      conflictPenalty === 0);

  return {
    total,
    entityScore: entitySim.score,
    titleScore,
    locationScore: locSim.score,
    conceptScore: conceptSim.score,
    timeScore,
    conflictPenalty,
    sharedEntities: entitySim.shared,
    matched,
  };
}

export function findBestMatchingCluster(
  article: {
    title: string;
    category?: NewsCategory;
    features: StoryFeatures;
    eventTime: number;
  },
  candidates: readonly ClusterCandidate[],
  maxCandidates: number = 100
): { cluster: ClusterCandidate; breakdown: ClusterMatchBreakdown } | null {
  const boundedCandidates = candidates.slice(0, maxCandidates);
  let best: {
    cluster: ClusterCandidate;
    breakdown: ClusterMatchBreakdown;
  } | null = null;

  for (const candidate of boundedCandidates) {
    if (Math.abs(article.eventTime - candidate.eventTime) > CLUSTER_WINDOW_MS) {
      continue;
    }

    const breakdown = computeClusterMatchScore(article, candidate);
    if (!breakdown.matched) continue;

    if (!best || breakdown.total > best.breakdown.total) {
      best = { cluster: candidate, breakdown };
    }
  }

  return best;
}