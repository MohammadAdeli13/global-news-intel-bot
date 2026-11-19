import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  computeClusterMatchScore,
  computeUrlHash,
  detectOriginAttribution,
  extractStoryFeatures,
  findBestMatchingCluster,
  type ClusterCandidate,
} from "../src/dedup";

describe("Phase 4 Deduplication, Publisher Independence & 5D Clustering", () => {
  it("canonicalizes URLs by stripping tracking parameters and produces deterministic SHA-256 hashes", async () => {
    const a = canonicalizeUrl(
      "HTTPS://News.Example.com:443/world/story-1/?utm_source=twitter&b=2&fbclid=xyz&a=1#section"
    );
    const b = canonicalizeUrl(
      "https://news.example.com/world/story-1?a=1&b=2"
    );
    expect(a).toBe(b);
    expect(a).toBe("https://news.example.com/world/story-1?a=1&b=2");

    const hashA = await computeUrlHash(a);
    const hashB = await computeUrlHash(b);
    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it("detects syndicated wire attribution conservatively without fabricating independence", () => {
    const site1 = detectOriginAttribution({
      title: "Oil prices jump after Red Sea attack (Reuters)",
      summary: "Crude futures rose 4% on Thursday.",
      author: null,
      publisherGroup: "site_alpha",
    });
    const site2 = detectOriginAttribution({
      title: "Crude surges following Red Sea strike",
      summary: "According to Reuters, shipping firms rerouted vessels.",
      author: "Reuters Staff",
      publisherGroup: "site_beta",
    });
    const independent = detectOriginAttribution({
      title: "Red Sea tanker hit by drone, naval officials tell BBC",
      summary: "Correspondents in the region confirmed damage.",
      author: "BBC Security Correspondent",
      publisherGroup: "bbc",
    });

    expect(site1.effectiveOriginKey).toBe("wire:reuters");
    expect(site1.originType).toBe("wire_heuristic");
    expect(site2.effectiveOriginKey).toBe("wire:reuters");
    expect(independent.effectiveOriginKey).toBe("pub:bbc");
    expect(independent.originType).toBe("publisher_group");
  });

  it("merges two differently worded headlines covering the same event via 5D signals (entities + location + concepts + time)", () => {
    const baseTime = Date.parse("2026-11-19T12:00:00Z");
    const firstFeatures = extractStoryFeatures(
      "Missile strike hits energy facility near Kyiv overnight",
      "Ukrainian air defenses intercepted several drones launched by Russia."
    );

    const existingCluster: ClusterCandidate = {
      id: 101,
      primaryTitle: "Missile strike hits energy facility near Kyiv overnight",
      category: "missile_drone",
      entities: firstFeatures.entities,
      locations: firstFeatures.locations,
      concepts: firstFeatures.concepts,
      eventTime: baseTime,
    };

    const secondTitle =
      "Russian airstrike and rocket attack damage power grid in Kyiv";
    const secondFeatures = extractStoryFeatures(
      secondTitle,
      "Ukraine officials reported overnight bombardment targeting power infrastructure."
    );

    const match = findBestMatchingCluster(
      {
        title: secondTitle,
        category: "missile_drone",
        features: secondFeatures,
        eventTime: baseTime + 2 * 60 * 60 * 1000,
      },
      [existingCluster]
    );

    expect(match).not.toBeNull();
    expect(match?.cluster.id).toBe(101);
    expect(match?.breakdown.total).toBeGreaterThanOrEqual(0.62);
  });

  it("applies location conflict penalty so simultaneous strikes in different regions stay separate", () => {
    const baseTime = Date.parse("2026-11-19T12:00:00Z");
    const kyivFeatures = extractStoryFeatures(
      "Ballistic missile strike hits infrastructure in Kyiv",
      "Ukraine air defense responded to the barrage."
    );
    const kyivCluster: ClusterCandidate = {
      id: 201,
      primaryTitle: "Ballistic missile strike hits infrastructure in Kyiv",
      category: "missile_drone",
      entities: kyivFeatures.entities,
      locations: kyivFeatures.locations,
      concepts: kyivFeatures.concepts,
      eventTime: baseTime,
    };

    const redSeaTitle = "Ballistic missile strike targets commercial ship in Red Sea";
    const redSeaFeatures = extractStoryFeatures(
      redSeaTitle,
      "Houthi forces launched an anti-ship missile near Aden."
    );

    const breakdown = computeClusterMatchScore(
      {
        title: redSeaTitle,
        category: "missile_drone",
        features: redSeaFeatures,
        eventTime: baseTime + 30 * 60 * 1000,
      },
      kyivCluster
    );

    expect(breakdown.conflictPenalty).toBe(0.25);
    expect(breakdown.matched).toBe(false);
  });

  it("verifies algorithmic scaling on 100 active clusters without ReDoS (local check only, not Cloudflare CPU proof)", () => {
    const baseTime = Date.parse("2026-11-19T12:00:00Z");
    const candidates: ClusterCandidate[] = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      primaryTitle: `Economic policy statement number ${i} from regional bank`,
      category: "central_banks",
      entities: ["fed", `pn:bank${i}`],
      locations: ["usa"],
      concepts: ["CONCEPT_RATE"],
      eventTime: baseTime - i * 60_000,
    }));

    const probeTitle = "Federal Reserve announces 25 bps interest rate cut";
    const probeFeatures = extractStoryFeatures(
      probeTitle,
      "Monetary policy committee eases rates in Washington."
    );

    // Must cap comparison to 100 candidates and complete cleanly without throwing
    const result = findBestMatchingCluster(
      {
        title: probeTitle,
        category: "central_banks",
        features: probeFeatures,
        eventTime: baseTime,
      },
      candidates,
      100
    );
    expect(result === null || result.cluster.id <= 100).toBe(true);
  });
});