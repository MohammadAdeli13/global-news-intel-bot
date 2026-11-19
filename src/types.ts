export const NEWS_CATEGORIES = [
  "war_military",
  "missile_drone",
  "geopolitics_diplomacy",
  "terrorism_security",
  "nuclear",
  "cyber_infrastructure",
  "sanctions_policy",
  "energy_oil_gas",
  "economy_finance",
  "central_banks",
  "natural_disasters",
  "public_health",
  "elections_governance",
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export type PublishLanguage = "fa" | "en";
export type AnalysisLength = "short" | "medium" | "detailed";
export type GeminiFallbackBehavior = "queue" | "publish_without_ai";
export type CheckIntervalMinutes = 5 | 10 | 15 | 30 | 60;

export type SourceType = "rss" | "atom" | "gdelt";
export type SourceStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";
export type CredibilityTier = 1 | 2 | 3;

export type UrgencyLevel = "low" | "normal" | "high" | "critical";
export type VerificationLabel = "unverified" | "single_source" | "corroborated";
export type ClusterStatus = "COLLECTING" | "QUEUED" | "PUBLISHED" | "DROPPED";

export type OriginType = "publisher_group" | "wire_heuristic";
export type AttributionConfidence = "high" | "medium" | "low";

export type PublicationEventType = "INITIAL" | "UPDATE";
export type OutboxStatus = "PENDING" | "SENDING" | "SENT" | "FAILED";
export type OutboxFailureCode =
  | "RATE_LIMITED"
  | "PERMANENT_TELEGRAM_ERROR"
  | "AMBIGUOUS_DELIVERY_STATE";

export type JobType = "RUN_ONCE" | "TEST_FEEDS" | "CLEANUP";
export type JobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface BotSettings {
  targetChannel: string | null;
  enabledCategories: NewsCategory[];
  minImportanceScore: number;
  minCredibilityScore: number;
  geminiEnabled: boolean;
  geminiModel: string;
  geminiFallbackModel: string;
  geminiDailyLimit: number;
  geminiFallbackBehavior: GeminiFallbackBehavior;
  analysisLength: AnalysisLength;
  checkIntervalMinutes: CheckIntervalMinutes;
  maxPostsPerHour: number;
  maxPostsPerDay: number;
  maxFeedsPerTick: number;
  maxItemsPerFeed: number;
  maxActiveClustersToCompare: number;
  updateCooldownMinutes: number;
  maxUpdatesPerCluster: number;
  gdeltEnabled: boolean;
  isPaused: boolean;
  language: PublishLanguage;
}

export const DEFAULT_SETTINGS: BotSettings = {
  targetChannel: null,
  enabledCategories: [...NEWS_CATEGORIES],
  minImportanceScore: 65,
  minCredibilityScore: 55,
  geminiEnabled: true,
  // Exact API model slug will be verified from Google AI Studio in Phase 6
  geminiModel: "gemini-3.5-flash-lite",
  geminiFallbackModel: "gemini-3.1-flash-lite",
  geminiDailyLimit: 400,
  geminiFallbackBehavior: "publish_without_ai",
  analysisLength: "short",
  checkIntervalMinutes: 5,
  maxPostsPerHour: 4,
  maxPostsPerDay: 25,
  maxFeedsPerTick: 2,
  maxItemsPerFeed: 25,
  maxActiveClustersToCompare: 100,
  updateCooldownMinutes: 30,
  maxUpdatesPerCluster: 3,
  gdeltEnabled: false,
  isPaused: false,
  language: "fa",
};

export interface LeaseRecord {
  lock_name: string;
  owner_id: string;
  fencing_token: number;
  acquired_at: number;
  expires_at: number;
}

export interface LeaseContext {
  lockName: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
}

export interface SourceRecord {
  id: number;
  name: string;
  url: string;
  type: SourceType;
  publisher_group: string;
  is_wire_agency: number;
  credibility_tier: CredibilityTier;
  base_credibility: number;
  status: SourceStatus;
  archived_at: number | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number;
  next_fetch_at: number;
  consecutive_failures: number;
  last_error: string | null;
}

export interface UpsertSourceInput {
  name: string;
  url: string;
  type: SourceType;
  publisherGroup: string;
  isWireAgency?: boolean;
  credibilityTier: CredibilityTier;
  baseCredibility: number;
}

export interface StoryClusterRecord {
  id: number;
  primary_title: string;
  category: NewsCategory;
  entities_json: string;
  locations_json: string;
  concepts_json: string;
  event_time: number;
  raw_article_count: number;
  independent_source_count: number;
  importance_score: number;
  credibility_score: number;
  confidence_score: number;
  urgency: UrgencyLevel;
  verification_label: VerificationLabel;
  status: ClusterStatus;
  latest_revision: number;
  last_published_at: number | null;
  last_published_importance: number | null;
  last_published_urgency: UrgencyLevel | null;
  last_published_verification: VerificationLabel | null;
  last_published_concepts_json: string | null;
  ai_payload_json: string | null;
  ai_attempts: number;
  created_at: number;
  updated_at: number;
}

export interface CreateClusterInput {
  primaryTitle: string;
  category: NewsCategory;
  entities: string[];
  locations: string[];
  concepts: string[];
  eventTime: number;
  importanceScore: number;
  credibilityScore: number;
  confidenceScore: number;
  urgency: UrgencyLevel;
  verificationLabel: VerificationLabel;
  status?: ClusterStatus;
}

export interface InsertArticleInput {
  clusterId: number;
  sourceId: number;
  urlHash: string;
  canonicalUrl: string;
  title: string;
  summary: string | null;
  author: string | null;
  publisherGroup: string;
  detectedWireName: string | null;
  effectiveOriginKey: string;
  originType: OriginType;
  attributionConfidence: AttributionConfidence;
  publishedAt: number;
}

export interface ClusterSourceRecord {
  cluster_id: number;
  effective_origin_key: string;
  origin_type: OriginType;
  attribution_confidence: AttributionConfidence;
  detected_wire_name: string | null;
  first_source_id: number;
  first_article_id: number;
  article_count: number;
  created_at: number;
}

export interface OutboxRecord {
  id: number;
  dedup_key: string;
  cluster_id: number;
  revision_number: number;
  event_type: PublicationEventType;
  update_reason: string | null;
  channel_id: string;
  reply_to_message_id: number | null;
  language: PublishLanguage;
  has_ai_analysis: number;
  rendered_html: string;
  status: OutboxStatus;
  attempt_count: number;
  attempt_token: string | null;
  previous_attempt_token: string | null;
  sending_started_at: number | null;
  sending_lease_expires_at: number | null;
  next_retry_at: number;
  telegram_message_id: number | null;
  failure_code: OutboxFailureCode | null;
  failure_detail: string | null;
  last_manual_retry_by: string | null;
  last_manual_retry_at: number | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export interface EnqueueOutboxInput {
  clusterId: number;
  revisionNumber: number;
  eventType: PublicationEventType;
  updateReason: string | null;
  channelId: string;
  replyToMessageId: number | null;
  language: PublishLanguage;
  hasAiAnalysis: boolean;
  renderedHtml: string;
}

export interface PublicationSnapshot {
  importance: number;
  credibility: number;
  confidence: number;
  independentSources: number;
  verificationLabel: VerificationLabel;
  urgency: UrgencyLevel;
  conceptsJson: string;
}

export interface PublicationEventRecord {
  id: number;
  cluster_id: number;
  outbox_id: number;
  revision_number: number;
  event_type: PublicationEventType;
  update_reason: string | null;
  channel_id: string;
  telegram_message_id: number;
  parent_telegram_message_id: number | null;
  language: PublishLanguage;
  has_ai_analysis: number;
  snapshot_importance: number;
  snapshot_credibility: number;
  snapshot_confidence: number;
  snapshot_independent_sources: number;
  snapshot_verification_label: VerificationLabel;
  published_at: number;
}

export interface JobRecord {
  id: number;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload_json: string | null;
  requested_by_chat_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number;
  attempt_count: number;
  max_attempts: number;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SystemLogRecord {
  id: number;
  level: LogLevel;
  component: string;
  message: string;
  meta_json: string | null;
  created_at: number;
}

export class LeaseLostError extends Error {
  constructor(message = "Pipeline lease lost or expired") {
    super(message);
    this.name = "LeaseLostError";
  }
}