import { describe, expect, it } from "vitest";
import {
  classifyArticleCategory,
  evaluatePublishGate,
  evaluateUpdateMateriality,
  scoreCluster,
  type ScoringSourceSignal,
} from "../src/scoring";
import { DEFAULT_SETTINGS, NEWS_CATEGORIES, type NewsCategory } from "../src/types";

const TIER1_SOURCE: ScoringSourceSignal = {
  baseCredibility: 88,
  credibilityTier: 1,
  originType: "publisher_group",
  attributionConfidence: "high",
};

const TIER2_SOURCE: ScoringSourceSignal = {
  baseCredibility: 76,
  credibilityTier: 2,
  originType: "publisher_group",
  attributionConfidence: "high",
};

const TIER3_LOW_SOURCE: ScoringSourceSignal = {
  baseCredibility: 42,
  credibilityTier: 3,
  originType: "publisher_group",
  attributionConfidence: "low",
};

describe("Phase 5 News Scoring, Verification Labels & Update Materiality Gate", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");

  it("1. high-importance missile strike from 1 credible source gets single_source label", () => {
    const score = scoreCluster({
      primaryTitle: "Breaking: Ballistic missile strike hits port infrastructure, dozens killed",
      summaries: [
        "Emergency services rushed to the port after multiple ballistic missiles struck fuel depots early Thursday, leaving dozens dead and wounded.",
      ],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 30 * 60 * 1000,
      now,
    });

    expect(score.category).toBe("missile_drone");
    expect(score.importanceScore).toBeGreaterThanOrEqual(85);
    expect(score.credibilityScore).toBeGreaterThanOrEqual(80);
    expect(score.urgency).toBe("critical");
    expect(score.verificationLabel).toBe("single_source");
  });

  it("2. same event corroborated by 3 independent sources upgrades confidence and becomes corroborated", () => {
    const single = scoreCluster({
      primaryTitle: "Ballistic missile strike hits port infrastructure, dozens killed",
      summaries: [
        "Multiple ballistic missiles struck the port facility overnight according to regional officials.",
      ],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 30 * 60 * 1000,
      now,
    });

    const multi = scoreCluster({
      primaryTitle: "Ballistic missile strike hits port infrastructure, dozens killed",
      summaries: [
        "Multiple ballistic missiles struck the port facility overnight.",
        "Defense ministry confirmed casualties and damage to energy terminals.",
      ],
      independentSources: [TIER1_SOURCE, TIER2_SOURCE, TIER1_SOURCE],
      rawArticleCount: 4,
      eventTime: now - 30 * 60 * 1000,
      now,
    });

    expect(multi.verificationLabel).toBe("corroborated");
    expect(multi.confidenceScore).toBeGreaterThan(single.confidenceScore);
    expect(multi.credibilityScore).toBeGreaterThan(single.credibilityScore);
  });

  it("3. strictly separates Importance from Credibility: alarming rumor from weak source is high importance, low credibility, unverified, and blocked", () => {
    const score = scoreCluster({
      primaryTitle: "Unconfirmed reports claim nuclear warhead alert issued amid retaliation fears",
      summaries: ["Unverified social posts allegedly describe emergency military movements."],
      independentSources: [TIER3_LOW_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 15 * 60 * 1000,
      now,
    });

    expect(score.category).toBe("nuclear");
    expect(score.importanceScore).toBeGreaterThanOrEqual(70);
    expect(score.credibilityScore).toBeLessThan(50);
    expect(score.verificationLabel).toBe("unverified");

    const gate = evaluatePublishGate(score, DEFAULT_SETTINGS);
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toContain("credibility_below_threshold");
  });

  it("4. single credible source with explicit unconfirmed hedging is labeled unverified", () => {
    const score = scoreCluster({
      primaryTitle: "Unconfirmed reports of drone strike near refinery",
      summaries: ["Authorities said claims could not be independently verified."],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 10 * 60 * 1000,
      now,
    });

    expect(score.hasStrongUncertainty).toBe(true);
    expect(score.verificationLabel).toBe("unverified");
  });

  it("5. penalizes opinion and analysis articles even when containing war/oil keywords", () => {
    const opinion = scoreCluster({
      primaryTitle: "Opinion: What oil prices and war mean for the next decade",
      summaries: ["In this editorial analysis, we review long-term market trends."],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 60 * 60 * 1000,
      now,
    });

    expect(opinion.noisePenalty).toBeGreaterThanOrEqual(30);
    expect(opinion.importanceScore).toBeLessThan(DEFAULT_SETTINGS.minImportanceScore);
    expect(evaluatePublishGate(opinion, DEFAULT_SETTINGS).eligible).toBe(false);
  });

  it("6. rejects off-topic sports and entertainment articles cleanly", () => {
    const sports = scoreCluster({
      primaryTitle: "Premier League: Striker nets hat-trick in dramatic win",
      summaries: ["The club secured three points ahead of the Champions League fixture."],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 20 * 60 * 1000,
      now,
    });

    expect(sports.matchedAnyTargetTopic).toBe(false);
    expect(sports.importanceScore).toBeLessThan(20);
    expect(evaluatePublishGate(sports, DEFAULT_SETTINGS).eligible).toBe(false);
  });

  it("7. classifies all 13 target news categories accurately", () => {
    const samples: [NewsCategory, string][] = [
      ["war_military", "Ground offensive intensifies as troops advance along frontline"],
      ["missile_drone", "Ballistic missile barrage intercepted over coastal base"],
      ["geopolitics_diplomacy", "Emergency UN Security Council summit called after ambassador expelled"],
      ["terrorism_security", "Suicide bombing at central station leaves hostages and casualties"],
      ["nuclear", "IAEA warns of rapid uranium enrichment toward weapons-grade levels"],
      ["cyber_infrastructure", "Ransomware cyberattack triggers national power grid outage"],
      ["sanctions_policy", "Treasury announces sweeping sanctions package and export ban"],
      ["energy_oil_gas", "OPEC+ slashes crude oil output as LNG pipeline shutdown hits supply"],
      ["economy_finance", "Major bank collapse sparks sovereign default and bailout talks"],
      ["central_banks", "Federal Reserve announces 50 bps interest rate cut in monetary policy shift"],
      ["natural_disasters", "Magnitude 7.4 earthquake triggers tsunami warning across coastal towns"],
      ["public_health", "WHO declares public health emergency over deadly avian flu H5N1 outbreak"],
      ["elections_governance", "Military coup ousts president and dissolves parliament"],
    ];

    const covered = new Set<NewsCategory>();
    for (const [expectedCat, title] of samples) {
      const res = classifyArticleCategory(title, null);
      expect(res.category, `Failed on: ${title}`).toBe(expectedCat);
      expect(res.matchedAnyTargetTopic).toBe(true);
      covered.add(res.category);
    }
    expect(covered.size).toBe(NEWS_CATEGORIES.length);
  });

  it("8. respects disabled categories in publish gate", () => {
    const score = scoreCluster({
      primaryTitle: "Federal Reserve announces emergency 50 bps interest rate cut",
      summaries: ["Central bank moved swiftly to stabilize credit markets."],
      independentSources: [TIER1_SOURCE, TIER2_SOURCE],
      rawArticleCount: 2,
      eventTime: now - 15 * 60 * 1000,
      now,
    });

    expect(score.category).toBe("central_banks");
    expect(
      evaluatePublishGate(score, {
        ...DEFAULT_SETTINGS,
        enabledCategories: DEFAULT_SETTINGS.enabledCategories.filter(
          (c) => c !== "central_banks"
        ),
      })
    ).toEqual({ eligible: false, reason: "category_disabled:central_banks" });
  });

  it("9. penalizes stale news older than 24 hours", () => {
    const fresh = scoreCluster({
      primaryTitle: "Emergency sanctions package imposed on energy sector",
      summaries: ["New export bans take effect immediately."],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 1 * 60 * 60 * 1000,
      now,
    });
    const stale = scoreCluster({
      primaryTitle: "Emergency sanctions package imposed on energy sector",
      summaries: ["New export bans take effect immediately."],
      independentSources: [TIER1_SOURCE],
      rawArticleCount: 1,
      eventTime: now - 48 * 60 * 60 * 1000,
      now,
    });

    expect(stale.importanceScore).toBeLessThan(fresh.importanceScore);
  });

  it("10. update materiality gate blocks minor updates with no material trigger", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 2 * 60 * 60 * 1000,
      lastPublishedAt: now - 60 * 60 * 1000,
      lastPublishedImportance: 78,
      lastPublishedUrgency: "high",
      lastPublishedVerification: "corroborated",
      lastPublishedConcepts: ["CONCEPT_STRIKE"],
      currentImportance: 82,
      currentUrgency: "high",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_STRIKE"],
      currentIndependentSources: 3,
      previousIndependentSources: 2,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.blockedBy).toBe("no_material_trigger");
  });

  it("11. update materiality gate enforces cooldown for non-critical updates", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 20 * 60 * 1000,
      lastPublishedAt: now - 10 * 60 * 1000,
      lastPublishedImportance: 70,
      lastPublishedUrgency: "normal",
      lastPublishedVerification: "single_source",
      lastPublishedConcepts: ["CONCEPT_SANCTION"],
      currentImportance: 76,
      currentUrgency: "high",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_SANCTION"],
      currentIndependentSources: 3,
      previousIndependentSources: 1,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.blockedBy).toBe("cooldown_active");
  });

  it("12. update materiality gate allows bypassing cooldown when urgency escalates to CRITICAL", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 15 * 60 * 1000,
      lastPublishedAt: now - 10 * 60 * 1000,
      lastPublishedImportance: 74,
      lastPublishedUrgency: "high",
      lastPublishedVerification: "single_source",
      lastPublishedConcepts: ["CONCEPT_STRIKE"],
      currentImportance: 92,
      currentUrgency: "critical",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_STRIKE", "CONCEPT_CASUALTIES"],
      currentIndependentSources: 3,
      previousIndependentSources: 1,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(true);
    expect(decision.reasonCode).toBe("URGENCY_ESCALATED");
    expect(decision.bypassedCooldown).toBe(true);
  });

  it("13. update materiality gate triggers on verification upgrade (single_source -> corroborated)", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 60 * 60 * 1000,
      lastPublishedAt: now - 45 * 60 * 1000,
      lastPublishedImportance: 78,
      lastPublishedUrgency: "high",
      lastPublishedVerification: "single_source",
      lastPublishedConcepts: ["CONCEPT_STRIKE"],
      currentImportance: 82,
      currentUrgency: "high",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_STRIKE"],
      currentIndependentSources: 3,
      previousIndependentSources: 1,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(true);
    expect(decision.reasonCode).toBe("VERIFICATION_UPGRADED");
    expect(decision.reasonFa).toContain("3 منبع");
  });

  it("14. update materiality gate triggers on material new concept reported by a new independent source", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 90 * 60 * 1000,
      lastPublishedAt: now - 45 * 60 * 1000,
      lastPublishedImportance: 80,
      lastPublishedUrgency: "high",
      lastPublishedVerification: "corroborated",
      lastPublishedConcepts: ["CONCEPT_MILITARY_OP"],
      currentImportance: 84,
      currentUrgency: "high",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_MILITARY_OP", "CONCEPT_CEASEFIRE"],
      currentIndependentSources: 3,
      previousIndependentSources: 2,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(true);
    expect(decision.reasonCode).toBe("MATERIAL_NEW_DEVELOPMENT");
  });

  it("15. update materiality gate enforces maxUpdatesPerCluster cap", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 4, // 1 INITIAL + 3 UPDATEs already sent
      initialPublishedAt: now - 5 * 60 * 60 * 1000,
      lastPublishedAt: now - 60 * 60 * 1000,
      lastPublishedImportance: 75,
      lastPublishedUrgency: "high",
      lastPublishedVerification: "single_source",
      lastPublishedConcepts: [],
      currentImportance: 95,
      currentUrgency: "critical",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_CASUALTIES"],
      currentIndependentSources: 5,
      previousIndependentSources: 1,
      settings: { updateCooldownMinutes: 30, maxUpdatesPerCluster: 3 },
      now,
    });

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.blockedBy).toBe("max_updates_reached");
  });

  it("16. update materiality gate blocks updates after 24-hour window expires", () => {
    const decision = evaluateUpdateMateriality({
      latestRevision: 1,
      initialPublishedAt: now - 25 * 60 * 60 * 1000,
      lastPublishedAt: now - 25 * 60 * 60 * 1000,
      lastPublishedImportance: 70,
      lastPublishedUrgency: "normal",
      lastPublishedVerification: "single_source",
      lastPublishedConcepts: [],
      currentImportance: 90,
      currentUrgency: "critical",
      currentVerification: "corroborated",
      currentConcepts: ["CONCEPT_RETALIATION"],
      currentIndependentSources: 4,
      previousIndependentSources: 1,
      settings: DEFAULT_SETTINGS,
      now,
    });

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.blockedBy).toBe("update_window_expired");
  });
});