import { categoryKey, matchesLanguage } from "./category-selection";
import { SourceType } from "../models/sourceType";

describe("category selection identities and optional language helpers", () => {
  it("matches exact M3U names and separates media types", () => {
    const category = { category_name: " Group ", media_type: 0, provider_category_id: null };
    expect(categoryKey(category, SourceType.M3U)).not.toEqual(categoryKey({ ...category, media_type: 1 }, SourceType.M3U));
    expect(categoryKey(category, SourceType.M3U)).not.toEqual(categoryKey({ ...category, category_name: "Group" }, SourceType.M3U));
    expect(categoryKey({ ...category, category_name: null }, SourceType.M3U)).not.toEqual(categoryKey({ ...category, category_name: "" }, SourceType.M3U));
  });
  it("uses Xtream IDs even when the category display name changes", () => {
    const category = { category_name: "Old", media_type: 2, provider_category_id: "0042" };
    expect(categoryKey(category, SourceType.Xtream)).toEqual(categoryKey({ ...category, category_name: "New" }, SourceType.Xtream));
    expect(categoryKey(category, SourceType.Xtream)).not.toEqual(categoryKey({ ...category, provider_category_id: "42" }, SourceType.Xtream));
  });
  it("keeps optional language prefixes separate from arbitrary manual identities", () => {
    for (const name of ["DE| Action", "EU- DE Sport"]) expect(matchesLanguage(name, "de")).toBeTrue();
    for (const name of ["EN| Drama", "EU- UK News"]) expect(matchesLanguage(name, "en")).toBeTrue();
    for (const name of [null, "Other", "DE unrelated", "X DE| Action"]) expect(matchesLanguage(name, "de")).toBeFalse();
    expect(matchesLanguage("DE| Action", "en")).toBeFalse();
    expect(categoryKey({ category_name: "Arbitrary provider group", media_type: 0, provider_category_id: null }, SourceType.M3U)).toContain("Arbitrary provider group");
  });
});
