import { SourceType } from "../models/sourceType";

export interface ProviderCategory {
  name: string | null;
  media_type: number;
  provider_category_id: string | null;
  entry_count: number | null;
}
export interface CategorySelection {
  category_name: string | null;
  media_type: number;
  provider_category_id: string | null;
}
export function categoryKey(category: CategorySelection, kind: SourceType): string {
  return JSON.stringify([category.media_type, kind === SourceType.Xtream
    ? category.provider_category_id : category.category_name]);
}
// Temporary, optional convenience helpers for observed provider names only.
export function matchesLanguage(name: string | null, language: "de" | "en"): boolean {
  const prefixes = language === "de" ? ["DE|", "EU- DE"] : ["EN|", "EU- UK"];
  return name !== null && prefixes.some(prefix => name.startsWith(prefix));
}
