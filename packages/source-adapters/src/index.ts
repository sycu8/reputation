import type { BooleanAst } from "../../boolean-query/src/index.ts";

export type SourceType = "web" | "news" | "rss" | "youtube" | "reddit" | "x" | "facebook" | "tiktok" | "linkedin";
export type SourceAvailability = "native-api" | "public-web" | "licensed-provider" | "contract-required" | "degraded" | "disabled";

export interface SourceCapabilities {
  keywordSearch: boolean;
  booleanSearch: boolean;
  historicalSearch: boolean;
  comments: boolean;
  engagement: boolean;
  renderMayBeRequired: boolean;
}

export interface DiscoveryInput {
  query: string;
  ast: BooleanAst;
  since?: string;
  cursor?: string | undefined;
  limit: number;
}

export interface DiscoveryResult {
  source: SourceType;
  url: string;
  nativeId?: string;
  title?: string | undefined;
  snippet?: string | undefined;
  author?: string | undefined;
  publishedAt?: string | undefined;
  cursor?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface DiscoveryProvider {
  readonly id: string;
  readonly source: SourceType;
  readonly availability: SourceAvailability;
  readonly capabilities: SourceCapabilities;
  discover(input: DiscoveryInput): Promise<DiscoveryResult[]>;
}

export interface RawSourceContent {
  source: SourceType;
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: string;
  headers: Record<string, string>;
}

export interface NormalizedContent {
  source: SourceType;
  canonicalUrl: string;
  title?: string | undefined;
  text: string;
  author?: string | undefined;
  publishedAt?: string | undefined;
  language?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly source: SourceType;
  readonly availability: SourceAvailability;
  readonly capabilities: SourceCapabilities;
  normalize(raw: RawSourceContent): Promise<NormalizedContent>;
}

export const SOURCE_CAPABILITY_DEFAULTS: Record<SourceType, { availability: SourceAvailability; capabilities: SourceCapabilities }> = {
  web: { availability: "public-web", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } },
  news: { availability: "licensed-provider", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: true, comments: false, engagement: false, renderMayBeRequired: true } },
  rss: { availability: "public-web", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: true, comments: false, engagement: false, renderMayBeRequired: false } },
  youtube: { availability: "native-api", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: true, comments: true, engagement: true, renderMayBeRequired: false } },
  reddit: { availability: "contract-required", capabilities: { keywordSearch: true, booleanSearch: false, historicalSearch: true, comments: true, engagement: true, renderMayBeRequired: false } },
  x: { availability: "native-api", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: false, comments: true, engagement: true, renderMayBeRequired: false } },
  facebook: { availability: "degraded", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } },
  tiktok: { availability: "degraded", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: false, engagement: true, renderMayBeRequired: true } },
  linkedin: { availability: "degraded", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } }
};
