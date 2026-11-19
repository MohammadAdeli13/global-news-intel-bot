import type {
  BotSettings,
  CredibilityTier,
  NewsCategory,
  UrgencyLevel,
  VerificationLabel,
} from "./types";

// ============================================================================
// 1. Category Classification (All 13 Target Domains)
// ============================================================================

interface CategoryRule {
  category: NewsCategory;
  strong: RegExp[];
  standard: RegExp[];
  baseImportance: number;
  acuteKinetic: boolean;
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "nuclear",
    baseImportance: 68,
    acuteKinetic: true,
    strong: [
      /\b(?:nuclear (?:strike|attack|weapon|warhead|threat|test|detonation|alert|doctrine)|uranium enrichment|weapons[- ]grade|iaea emergency|reactor meltdown|radiation leak)\b/i,
    ],
    standard: [
      /\b(?:nuclear|uranium|plutonium|warhead|icbm|iaea|atomic energy|centrifuges?|fissile)\b/i,
    ],
  },
  {
    category: "missile_drone",
    baseImportance: 66,
    acuteKinetic: true,
    strong: [
      /\b(?:ballistic missile|cruise missile|hypersonic missile|missile strike|missile barrage|drone strike|drone attack|drone swarm|airstrike|air strike|rocket attack|rocket barrage|air defense intercepted)\b/i,
    ],
    standard: [
      /\b(?:missile|rockets?|uav|drones?|shelling|bombardment|interception|launcher)\b/i,
    ],
  },
  {
    category: "war_military",
    baseImportance: 62,
    acuteKinetic: true,
    strong: [
      /\b(?:full[- ]scale invasion|ground offensive|military operation|declaration of war|naval blockade|troops deployed|heavy fighting|frontline collapse|warships? deployed|martial law|ceasefire collapse)\b/i,
    ],
    standard: [
      /\b(?:war|warfare|army|troops|military|combat|clashes|offensive|artillery|ceasefire|truce|battalion|idf|nato forces|pentagon)\b/i,
    ],
  },
  {
    category: "terrorism_security",
    baseImportance: 62,
    acuteKinetic: true,
    strong: [
      /\b(?:terror(?:ist)? attack|suicide bomb(?:ing|er)?|car bomb|mass shooting|hostage crisis|assassination|claimed responsibility|explosive device)\b/i,
    ],
    standard: [
      /\b(?:terrorism|terrorist|militants?|extremist|isis|islamic state|al[- ]qaeda|hostages?|insurgent|security threat)\b/i,
    ],
  },
  {
    category: "cyber_infrastructure",
    baseImportance: 58,
    acuteKinetic: true,
    strong: [
      /\b(?:cyberattack on|critical infrastructure|power grid (?:hack|outage|attack)|ransomware attack|national (?:grid|telecom|banking) outage|submarine cable (?:cut|sabotage)|zero[- ]day exploit)\b/i,
    ],
    standard: [
      /\b(?:cyberattack|cyber warfare|ransomware|state[- ]backed hackers?|data breach|ddos|sabotage|infrastructure outage|espionage)\b/i,
    ],
  },
  {
    category: "sanctions_policy",
    baseImportance: 54,
    acuteKinetic: false,
    strong: [
      /\b(?:sweeping sanctions|new sanctions|sanctions package|export ban|oil embargo|asset freeze|tariffs? imposed|trade war|blacklist(?:ed|s)?)\b/i,
    ],
    standard: [
      /\b(?:sanctions?|embargo|tariffs?|export controls?|treasury designated|foreign policy|executive order|visa ban)\b/i,
    ],
  },
  {
    category: "geopolitics_diplomacy",
    baseImportance: 52,
    acuteKinetic: false,
    strong: [
      /\b(?:emergency (?:un |security council )?summit|diplomatic (?:crisis|rupture|ties severed)|ambassador (?:recalled|expelled)|defense pact|border standoff|ultimatum|security council resolution)\b/i,
    ],
    standard: [
      /\b(?:geopolitical|diplomatic|diplomacy|foreign minister|summit|bilateral|treaty|united nations|unsc|nato|strait of hormuz|taiwan strait|south china sea)\b/i,
    ],
  },
  {
    category: "energy_oil_gas",
    baseImportance: 54,
    acuteKinetic: false,
    strong: [
      /\b(?:opec\+? (?:cuts?|slashes|hikes)|oil (?:surge|plunge|shock|embargo)|pipeline (?:explosion|sabotage|shutdown)|lng supply (?:halt|crisis)|refinery (?:strike|fire|shutdown)|strait of hormuz|tanker (?:seized|attacked))\b/i,
    ],
    standard: [
      /\b(?:crude oil|brent|wti|natural gas|lng|opec|pipeline|refinery|energy crisis|oil prices?|gas supply|petroleum)\b/i,
    ],
  },
  {
    category: "central_banks",
    baseImportance: 56,
    acuteKinetic: false,
    strong: [
      /\b(?:interest rate (?:cut|hike|decision|hold)|federal reserve (?:cuts?|raises?|holds?)|ecb (?:cuts?|raises?|holds?)|emergency rate|basis points|bps|monetary policy decision|quantitative tightening)\b/i,
    ],
    standard: [
      /\b(?:federal reserve|the fed|fomc|ecb|european central bank|bank of england|bank of japan|central bank|powell|lagarde|inflation rate|interest rates?)\b/i,
    ],
  },
  {
    category: "economy_finance",
    baseImportance: 52,
    acuteKinetic: false,
    strong: [
      /\b(?:sovereign default|bank (?:collapse|run|failure|bailout)|financial crisis|market crash|stock (?:plunge|selloff)|currency (?:crash|collapse)|imf bailout|recession declared|debt ceiling crisis)\b/i,
    ],
    standard: [
      /\b(?:recession|inflation|gdp|sovereign debt|banking crisis|bailout|bond yields?|currency|imf|world bank|liquidity crisis|default)\b/i,
    ],
  },
  {
    category: "natural_disasters",
    baseImportance: 58,
    acuteKinetic: true,
    strong: [
      /\b(?:magnitude [6-9](?:\.\d)?|major earthquake|tsunami warning|category [3-5] hurricane|super typhoon|catastrophic flood(?:ing)?|volcanic eruption|state of emergency)\b/i,
    ],
    standard: [
      /\b(?:earthquake|tsunami|hurricane|typhoon|cyclone|wildfire|floods?|flooding|landslide|volcano|evacuation|quake)\b/i,
    ],
  },
  {
    category: "public_health",
    baseImportance: 54,
    acuteKinetic: false,
    strong: [
      /\b(?:public health emergency|who declares|pandemic|deadly outbreak|h5n1|avian flu|ebola|marburg|mpox emergency|quarantine imposed|vaccine shortage)\b/i,
    ],
    standard: [
      /\b(?:outbreak|epidemic|virus|pathogen|cholera|who|world health organization|cdc|infectious disease|health crisis|contamination)\b/i,
    ],
  },
  {
    category: "elections_governance",
    baseImportance: 52,
    acuteKinetic: false,
    strong: [
      /\b(?:military coup|coup attempt|president (?:resigns|impeached|ousted|elected)|prime minister (?:resigns|ousted|elected)|parliament dissolved|election results|constitutional crisis|state of emergency)\b/i,
    ],
    standard: [
      /\b(?:election|referendum|impeachment|parliament|coalition government|prime minister|president|cabinet reshuffle|opposition leader|ballot|polls?)\b/i,
    ],
  },
];

// ============================================================================
// 2. Severity Escalators, Noise/Opinion Penalties & Uncertainty Markers
// ============================================================================

const HIGH_SEVERITY_PATTERNS: readonly [RegExp, number][] = [
  [/\b(?:dozens|hundreds|thousands)\s+(?:killed|dead|wounded|evacuated)\b/i, 16],
  [/\b(?:killed|dead|deaths|casualties|death toll|fatalities)\b/i, 10],
  [/\b(?:breaking|urgent|emergency|red alert|sirens)\b/i, 8],
  [/\b(?:retaliation|retaliatory|escalation|direct strike|all[- ]out)\b/i, 10],
  [/\b(?:global|worldwide|international|nato|un security council|g7|opec\+)\b/i, 6],
  [/\b(?:confirmed|officially announced|statement confirmed)\b/i, 5],
  [/\b(?:billion|trillion|surge[sd]?|plunge[sd]?|record high|record low)\b/i, 5],
];

const NOISE_OPINION_PATTERNS: readonly [RegExp, number][] = [
  [/^(?:opinion|editorial|commentary|analysis|column|perspective|letters?|review|podcast|watch|listen|explainer|q&a)\s*[:|\-–—]/i, 36],
  [/\b(?:opinion|editorial|op-ed|podcast|book review|film review|movie review|crossword|horoscope|recipe|lifestyle|celebrity|box office)\b/i, 30],
  [/\b(?:analysis|explainer|what to know|what we know so far|everything you need to know|why it matters|in pictures|photo gallery|weekly roundup)\b/i, 22],
  [/\b(?:premier league|champions league|nba|nfl|mlb|world cup|tennis|golf|formula 1|oscars|grammy|kardashian)\b/i, 45],
];

const STRONG_UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /\b(?:unconfirmed|unverified|could not be independently verified|cannot be verified|rumors?|rumours?|speculation)\b/i,
];

const MILD_HEDGING_PATTERNS: readonly RegExp[] = [
  /\b(?:reportedly|allegedly|claims?|claimed|purportedly|unnamed sources|anonymous officials|sources say|believed to be|suspected)\b/i,
];

const OFFICIAL_CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /\b(?:confirmed|officially announced|official statement|ministry confirmed|defense ministry said|central bank announced|who declared)\b/i,
];

// ============================================================================
// 3. Public Types & Functions
// ============================================================================

export interface CategoryClassification {
  category: NewsCategory;
  matchedAnyTargetTopic: boolean;
  matchScore: number;
  baseImportance: number;
  acuteKinetic: boolean;
}

export interface ScoringSourceSignal {
  baseCredibility: number;
  credibilityTier: CredibilityTier;
  originType: "publisher_group" | "wire_heuristic";
  attributionConfidence: "high" | "medium" | "low";
}

export interface ClusterScoreInput {
  primaryTitle: string;
  summaries: readonly (string | null)[];
  independentSources: readonly ScoringSourceSignal[];
  rawArticleCount: number;
  eventTime: number;
  hasExplicitDate?: boolean;
  now?: number;
}

export interface ClusterScoreResult {
  category: NewsCategory;
  matchedAnyTargetTopic: boolean;
  importanceScore: number;
  credibilityScore: number;
  confidenceScore: number;
  urgency: UrgencyLevel;
  verificationLabel: VerificationLabel;
  noisePenalty: number;
  hasStrongUncertainty: boolean;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function classifyArticleCategory(
  title: string,
  summary: string | null
): CategoryClassification {
  const safeTitle = title || "";
  const safeSummary = summary || "";

  let bestRule: CategoryRule = CATEGORY_RULES[6]!; // geopolitics_diplomacy fallback
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;

    for (const rx of rule.strong) {
      if (rx.test(safeTitle)) score += 30;
      else if (rx.test(safeSummary)) score += 16;
    }

    for (const rx of rule.standard) {
      if (rx.test(safeTitle)) score += 14;
      else if (rx.test(safeSummary)) score += 7;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return {
    category: bestRule.category,
    matchedAnyTargetTopic: bestScore >= 14,
    matchScore: bestScore,
    baseImportance: bestRule.baseImportance,
    acuteKinetic: bestRule.acuteKinetic,
  };
}

export function detectNoisePenalty(title: string, summary: string | null): number {
  let penalty = 0;
  const trimmedTitle = title.trim();
  const combined = `${trimmedTitle} ${summary ?? ""}`;

  for (const [rx, weight] of NOISE_OPINION_PATTERNS) {
    if (rx.test(trimmedTitle)) {
      penalty = Math.max(penalty, weight);
    } else if (rx.test(combined)) {
      penalty = Math.max(penalty, Math.round(weight * 0.65));
    }
  }

  return penalty;
}

export function scoreCluster(input: ClusterScoreInput): ClusterScoreResult {
  const now = input.now ?? Date.now();
  const nonEmptySummaries = input.summaries.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0
  );
  const combinedSummary = nonEmptySummaries.join(" ").slice(0, 1200);
  const combinedText = `${input.primaryTitle} ${combinedSummary}`;

  const classification = classifyArticleCategory(
    input.primaryTitle,
    combinedSummary || null
  );
  const noisePenalty = detectNoisePenalty(
    input.primaryTitle,
    combinedSummary || null
  );

  const independentCount = input.independentSources.length;

  // --------------------------------------------------------------------------
  // A. Importance Score (0..100) - strictly independent of source credibility
  // --------------------------------------------------------------------------
  let importance = 0;
  if (!classification.matchedAnyTargetTopic) {
    importance = 18;
  } else {
    importance = classification.baseImportance;
    // Extra topic density bonus (capped at +12)
    importance += Math.min(12, Math.max(0, Math.round((classification.matchScore - 14) * 0.35)));

    // Severity escalators (capped at +24)
    let severityBoost = 0;
    for (const [rx, boost] of HIGH_SEVERITY_PATTERNS) {
      if (rx.test(input.primaryTitle)) {
        severityBoost += boost;
      } else if (rx.test(combinedSummary)) {
        severityBoost += Math.round(boost * 0.6);
      }
    }
    importance += Math.min(24, severityBoost);

    // Multi-outlet breaking momentum bonus (importance reflects global scale)
    if (independentCount >= 5) importance += 14;
    else if (independentCount >= 3) importance += 10;
    else if (independentCount === 2) importance += 6;
  }

  // Staleness reduction for old stories (> 24h)
  const ageHours = Math.max(0, (now - input.eventTime) / (60 * 60 * 1000));
  if (ageHours > 24) {
    importance -= Math.min(15, Math.round((ageHours - 24) * 0.75));
  }

  importance -= noisePenalty;
  const importanceScore = clampScore(importance);

  // --------------------------------------------------------------------------
  // B. Credibility Score (0..100) - based on independent sources, NOT importance
  // --------------------------------------------------------------------------
  let credibility = 30;
  if (independentCount > 0) {
    const sortedCreds = input.independentSources
      .map((s) => s.baseCredibility)
      .sort((a, b) => b - a);
    const highest = sortedCreds[0] ?? 50;
    const avg =
      sortedCreds.reduce((acc, v) => acc + v, 0) / sortedCreds.length;

    // Weighted blend favors strongest independent source without hiding weaker ones
    credibility = 0.6 * highest + 0.4 * avg;

    // Independent corroboration boost (only when truly >= 2 independent publishers)
    if (independentCount >= 4) credibility += 14;
    else if (independentCount === 3) credibility += 10;
    else if (independentCount === 2) credibility += 6;

    // Penalty if single source is only a low-confidence heuristic attribution
    if (
      independentCount === 1 &&
      input.independentSources[0]?.attributionConfidence === "low"
    ) {
      credibility -= 8;
    }
  }
  const credibilityScore = clampScore(credibility);

  // --------------------------------------------------------------------------
  // C. Confidence Score (0..100) - certainty of available facts
  // --------------------------------------------------------------------------
  let confidence = 25;
  if (independentCount === 1) confidence = 44;
  else if (independentCount === 2) confidence = 68;
  else if (independentCount === 3) confidence = 82;
  else if (independentCount >= 4) confidence = 90;

  // Best tier adjustment
  const bestTier = input.independentSources.reduce<number>(
    (minTier, s) => Math.min(minTier, s.credibilityTier),
    3
  );
  if (independentCount > 0) {
    if (bestTier === 1) confidence += 10;
    else if (bestTier === 2) confidence += 4;
    else confidence -= 10;
  }

  // Information completeness adjustment
  if (combinedSummary.length >= 100) {
    confidence += 6;
  } else if (combinedSummary.length === 0) {
    confidence -= 6;
  }
  if (input.hasExplicitDate !== false) {
    confidence += 2;
  }

  const hasStrongUncertainty = STRONG_UNCERTAINTY_PATTERNS.some((rx) =>
    rx.test(combinedText)
  );
  const hasMildHedging = MILD_HEDGING_PATTERNS.some((rx) =>
    rx.test(combinedText)
  );
  const hasOfficialConfirmation = OFFICIAL_CONFIRMATION_PATTERNS.some((rx) =>
    rx.test(combinedText)
  );

  if (hasStrongUncertainty) {
    confidence -= 22;
  } else if (hasMildHedging) {
    confidence -= 10;
  } else if (hasOfficialConfirmation && independentCount >= 1) {
    confidence += 6;
  }

  const confidenceScore = clampScore(confidence);

  // --------------------------------------------------------------------------
  // D. Verification Label (Strict single-source safety rule)
  // --------------------------------------------------------------------------
  let verificationLabel: VerificationLabel;
  if (independentCount <= 1) {
    if (hasStrongUncertainty || credibilityScore < 65 || confidenceScore < 45) {
      verificationLabel = "unverified";
    } else {
      verificationLabel = "single_source";
    }
  } else {
    if (credibilityScore < 50 || (hasStrongUncertainty && independentCount < 3)) {
      verificationLabel = "unverified";
    } else {
      verificationLabel = "corroborated";
    }
  }

  // --------------------------------------------------------------------------
  // E. Urgency Level
  // --------------------------------------------------------------------------
  let urgency: UrgencyLevel;
  if (
    importanceScore >= 85 &&
    classification.acuteKinetic &&
    ageHours <= 6
  ) {
    urgency = "critical";
  } else if (importanceScore >= 72) {
    urgency = "high";
  } else if (importanceScore >= 55) {
    urgency = "normal";
  } else {
    urgency = "low";
  }

  return {
    category: classification.category,
    matchedAnyTargetTopic: classification.matchedAnyTargetTopic,
    importanceScore,
    credibilityScore,
    confidenceScore,
    urgency,
    verificationLabel,
    noisePenalty,
    hasStrongUncertainty,
  };
}

// ============================================================================
// 4. Initial Publish Eligibility Gate
// ============================================================================

export interface PublishGateDecision {
  eligible: boolean;
  reason: string;
}

export function evaluatePublishGate(
  score: ClusterScoreResult,
  settings: Pick<
    BotSettings,
    "enabledCategories" | "minImportanceScore" | "minCredibilityScore"
  >
): PublishGateDecision {
  if (!score.matchedAnyTargetTopic) {
    return { eligible: false, reason: "outside_target_topics" };
  }
  if (!settings.enabledCategories.includes(score.category)) {
    return { eligible: false, reason: `category_disabled:${score.category}` };
  }
  if (score.importanceScore < settings.minImportanceScore) {
    return {
      eligible: false,
      reason: `importance_below_threshold:${score.importanceScore}<${settings.minImportanceScore}`,
    };
  }
  if (score.credibilityScore < settings.minCredibilityScore) {
    return {
      eligible: false,
      reason: `credibility_below_threshold:${score.credibilityScore}<${settings.minCredibilityScore}`,
    };
  }
  return { eligible: true, reason: "passed" };
}

// ============================================================================
// 5. Materiality Gate for Publishing UPDATE Revisions on Published Clusters
// ============================================================================

const URGENCY_RANK: Record<UrgencyLevel, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

const MATERIAL_UPDATE_CONCEPTS = new Set([
  "CONCEPT_CASUALTIES",
  "CONCEPT_RETALIATION",
  "CONCEPT_CEASEFIRE",
  "CONCEPT_OFFICIAL_CONFIRMATION",
  "CONCEPT_NUCLEAR",
  "CONCEPT_SANCTION",
]);

export const MAX_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UpdateMaterialityInput {
  latestRevision: number;
  initialPublishedAt: number;
  lastPublishedAt: number;
  lastPublishedImportance: number;
  lastPublishedUrgency: UrgencyLevel;
  lastPublishedVerification: VerificationLabel;
  lastPublishedConcepts: readonly string[];
  currentImportance: number;
  currentUrgency: UrgencyLevel;
  currentVerification: VerificationLabel;
  currentConcepts: readonly string[];
  currentIndependentSources: number;
  previousIndependentSources: number;
  settings: Pick<BotSettings, "updateCooldownMinutes" | "maxUpdatesPerCluster">;
  now?: number;
}

export interface UpdateMaterialityDecision {
  shouldUpdate: boolean;
  reasonCode:
    | "VERIFICATION_UPGRADED"
    | "URGENCY_ESCALATED"
    | "IMPORTANCE_SURGE"
    | "MATERIAL_NEW_DEVELOPMENT"
    | null;
  reasonFa: string | null;
  reasonEn: string | null;
  bypassedCooldown: boolean;
  blockedBy?: string;
}

export function evaluateUpdateMateriality(
  input: UpdateMaterialityInput
): UpdateMaterialityDecision {
  const now = input.now ?? Date.now();
  const updatesAlreadySent = Math.max(0, input.latestRevision - 1);

  if (updatesAlreadySent >= input.settings.maxUpdatesPerCluster) {
    return {
      shouldUpdate: false,
      reasonCode: null,
      reasonFa: null,
      reasonEn: null,
      bypassedCooldown: false,
      blockedBy: "max_updates_reached",
    };
  }

  if (now - input.initialPublishedAt > MAX_UPDATE_WINDOW_MS) {
    return {
      shouldUpdate: false,
      reasonCode: null,
      reasonFa: null,
      reasonEn: null,
      bypassedCooldown: false,
      blockedBy: "update_window_expired",
    };
  }

  const escalatedToCritical =
    input.currentUrgency === "critical" &&
    input.lastPublishedUrgency !== "critical";

  const cooldownMs = input.settings.updateCooldownMinutes * 60 * 1000;
  const withinCooldown = now - input.lastPublishedAt < cooldownMs;

  if (withinCooldown && !escalatedToCritical) {
    return {
      shouldUpdate: false,
      reasonCode: null,
      reasonFa: null,
      reasonEn: null,
      bypassedCooldown: false,
      blockedBy: "cooldown_active",
    };
  }

  // Trigger 1: Escalation to critical or higher urgency level
  if (URGENCY_RANK[input.currentUrgency] > URGENCY_RANK[input.lastPublishedUrgency]) {
    return {
      shouldUpdate: true,
      reasonCode: "URGENCY_ESCALATED",
      reasonFa: `افزایش سطح فوریت رویداد به ${input.currentUrgency.toUpperCase()}`,
      reasonEn: `Event urgency escalated to ${input.currentUrgency.toUpperCase()}`,
      bypassedCooldown: withinCooldown && escalatedToCritical,
    };
  }

  // Trigger 2: Verification upgraded from unverified / single_source -> corroborated
  if (
    input.lastPublishedVerification !== "corroborated" &&
    input.currentVerification === "corroborated" &&
    input.currentIndependentSources >= 2
  ) {
    return {
      shouldUpdate: true,
      reasonCode: "VERIFICATION_UPGRADED",
      reasonFa: `تأیید مستقل خبر توسط ${input.currentIndependentSources} منبع جداگانه`,
      reasonEn: `Independently corroborated by ${input.currentIndependentSources} distinct sources`,
      bypassedCooldown: false,
    };
  }

  // Trigger 3: Importance surge >= 15 points
  if (input.currentImportance - input.lastPublishedImportance >= 15) {
    return {
      shouldUpdate: true,
      reasonCode: "IMPORTANCE_SURGE",
      reasonFa: `جهش معنادار اهمیت رویداد (+${input.currentImportance - input.lastPublishedImportance} امتیاز)`,
      reasonEn: `Significant event escalation (+${input.currentImportance - input.lastPublishedImportance} importance)`,
      bypassedCooldown: false,
    };
  }

  // Trigger 4: Material new concept reported by at least one new independent source
  const hasNewIndependentSource =
    input.currentIndependentSources > input.previousIndependentSources;
  if (hasNewIndependentSource) {
    const prevSet = new Set(input.lastPublishedConcepts);
    const newlyAddedMaterial = input.currentConcepts.filter(
      (c) => MATERIAL_UPDATE_CONCEPTS.has(c) && !prevSet.has(c)
    );
    if (newlyAddedMaterial.length > 0) {
      return {
        shouldUpdate: true,
        reasonCode: "MATERIAL_NEW_DEVELOPMENT",
        reasonFa: "ثبت تحول مهم جدید با گزارش منبع مستقل تازه",
        reasonEn: "Material new development reported by an additional independent source",
        bypassedCooldown: false,
      };
    }
  }

  return {
    shouldUpdate: false,
    reasonCode: null,
    reasonFa: null,
    reasonEn: null,
    bypassedCooldown: false,
    blockedBy: "no_material_trigger",
  };
}