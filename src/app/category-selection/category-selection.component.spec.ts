import { CdkVirtualScrollViewport, FixedSizeVirtualScrollStrategy } from "@angular/cdk/scrolling";
import { AnalysisTransport, AnalysisProgress } from "./analysis-transport";
import { ProviderCategory } from "./category-selection";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { CategorySelectionComponent } from "./category-selection.component";
import { categoryKey } from "./category-selection";
import { SourceType } from "../models/sourceType";

describe("category dialog state", () => {
  function dialog(size = 28000) {
    const component = new CategorySelectionComponent(new NgbActiveModal());
    component.source = { source_type: SourceType.M3U, name: "Test", enabled: true };
    component.allRows = Array.from({ length: size }, (_, index) => {
      const name = index === 0 ? "DE| Example" : index === 1 ? "EN| Example" : `Other ${index}`;
      const selection = { category_name: name, media_type: index % 3, provider_category_id: null };
      return { key: categoryKey(selection, SourceType.M3U), selection,
        category: { name, media_type: selection.media_type, provider_category_id: null, entry_count: 10 },
        search: name.toLocaleLowerCase(), checked: false };
    });
    component.filter();
    return component;
  }
  it("switches media tabs and searches the full collection case-insensitively", () => {
    const component = dialog();
    expect(component.visibleRows.length).toBe(9334);
    component.switchTab(1);
    expect(component.visibleRows.length).toBe(9333);
    expect(component.visibleRows.every(row => row.category.media_type === 1)).toBeTrue();
    component.query = "en|";
    component.filter();
    expect(component.visibleRows.length).toBe(1);
    component.switchTab(0);
    expect(component.visibleRows.length).toBe(0);
    expect(component.sections[1].total).toBe(9333);
  });
  it("combines only-selected, search, media tabs, and additive helpers", () => {
    const component = dialog(30);
    component.onlySelected = true;
    component.filter();
    expect(component.visibleRows.length).toBe(0);
    component.choose("de");
    component.choose("en");
    expect(component.selected.size).toBe(2);
    expect(component.selectedEntries).toBe(20);
    expect(component.visibleRows.length).toBe(1);
    component.switchTab(1);
    expect(component.visibleRows.length).toBe(1);
    component.query = "not present";
    component.filter();
    expect(component.visibleRows.length).toBe(0);
    component.query = "EN|";
    component.filter();
    component.toggle(component.visibleRows[0], false);
    expect(component.visibleRows.length).toBe(0);
    expect(component.selectedEntries).toBe(10);
  });
  it("applies language helpers additively and clears selections explicitly", () => {
    const component = dialog(3);
    component.choose("de");
    component.choose("en");
    expect(component.selected.size).toBe(2);
    expect(component.selectedEntries).toBe(20);
    component.choose("none");
    expect(component.selected.size).toBe(0);
    expect(component.importAll).toBeFalse();
    component.clearFilter();
    expect(component.importAll).toBeTrue();
    expect(component.selected.size).toBe(3);
  });
  it("reports unknown counts and preserves saved identities missing from analysis", () => {
    const component = dialog(1);
    component.allRows[0].category.entry_count = null;
    component.choose("all");
    expect(component.selectedEntries).toBeNull();
    const missing = { category_name: "Absent", media_type: 2, provider_category_id: null };
    component.selected.set(categoryKey(missing, SourceType.M3U), missing);
    component.stats();
    expect(component.missingSelected).toBe(1);
    expect(component.selected.size).toBe(2);
    expect(component.selectedEntries).toBeNull();
  });
});

describe("analysis progress lifecycle", () => {
  function progress(requestId: string, phase: "ANALYZING" | "COMPLETE" = "ANALYZING") {
    return { request_id: requestId, phase, processed_bytes: 50, received_bytes: 50,
      total_bytes: 100, analyzed_entries: 4, category_count: 2, percentage: 50 };
  }
  it("subscribes before invoking, handles progress, completes, and removes the listener", async () => {
    const transport = jasmine.createSpyObj<AnalysisTransport>("transport", ["subscribe", "analyze"]);
    const unlisten = jasmine.createSpy("unlisten");
    let handler!: (event: AnalysisProgress) => void;
    let complete!: (categories: ProviderCategory[]) => void;
    transport.subscribe.and.callFake(async callback => { handler = callback; return unlisten; });
    transport.analyze.and.callFake(() => new Promise(resolve => { complete = resolve; }));
    const component = new CategorySelectionComponent(new NgbActiveModal(), transport);
    component.source = { name: "Test", source_type: SourceType.M3U };
    const running = component.analyze();
    await Promise.resolve();
    expect(transport.subscribe).toHaveBeenCalledBefore(transport.analyze);
    expect(component.analyzing).toBeTrue();
    const requestId = component.analysisRequestId!;
    handler(progress("stale"));
    expect(component.progress).toBeNull();
    handler(progress(requestId));
    expect(component.progress?.analyzed_entries).toBe(4);
    complete([{ name: "A", media_type: 0, provider_category_id: null, entry_count: 4 }]);
    await running;
    expect(component.analyzing).toBeFalse();
    expect(component.analyzed).toBeTrue();
    expect(component.totalEntries).toBe(4);
    expect(component.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
    handler(progress(requestId, "COMPLETE"));
    expect(component.progress?.phase).toBe("ANALYZING");
    component.ngOnDestroy();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
  it("cleans up failures and protects later runs from older events", async () => {
    const transport = jasmine.createSpyObj<AnalysisTransport>("transport", ["subscribe", "analyze"]);
    const unlisten = jasmine.createSpy("unlisten");
    transport.subscribe.and.resolveTo(unlisten);
    transport.analyze.and.rejectWith(new Error("synthetic failure"));
    const component = new CategorySelectionComponent(new NgbActiveModal(), transport);
    component.source = { name: "Test", source_type: SourceType.M3U };
    await component.analyze();
    expect(component.error).toContain("nicht analysieren");
    expect(component.busy).toBeFalse();
    expect(unlisten).toHaveBeenCalledTimes(1);
    transport.analyze.and.resolveTo([]);
    await component.analyze();
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(component.error).toBe("");
    expect(component.analyzed).toBeTrue();
  });
  it("unsubscribes if destruction occurs while subscription is pending", async () => {
    const transport = jasmine.createSpyObj<AnalysisTransport>("transport", ["subscribe", "analyze"]);
    let subscribed!: (unlisten: () => void) => void;
    transport.subscribe.and.callFake(() => new Promise(resolve => { subscribed = resolve; }));
    const component = new CategorySelectionComponent(new NgbActiveModal(), transport);
    component.source = { name: "Test", source_type: SourceType.M3U };
    const running = component.analyze();
    component.ngOnDestroy();
    const unlisten = jasmine.createSpy("unlisten");
    subscribed(unlisten);
    await running;
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(transport.analyze).not.toHaveBeenCalled();
  });
});

describe("CDK list windowing", () => {
  it("keeps the rendered range bounded while scrolling across 28k records", () => {
    let range = { start: 0, end: 0 };
    let offset = 0;
    const viewport = {
      getViewportSize: () => 440,
      getDataLength: () => 28000,
      getRenderedRange: () => range,
      measureScrollOffset: () => offset,
      setRenderedRange: (next: { start: number; end: number }) => { range = next; },
      setTotalContentSize: (_: number) => {},
      setRenderedContentOffset: (_: number) => {},
    } as unknown as CdkVirtualScrollViewport;
    const strategy = new FixedSizeVirtualScrollStrategy(44, 440, 880);
    strategy.attach(viewport);
    expect(range.end - range.start).toBeLessThanOrEqual(40);
    offset = 14000 * 44;
    strategy.onContentScrolled();
    expect(range.start).toBeGreaterThan(13000);
    expect(range.end - range.start).toBeLessThanOrEqual(40);
    strategy.detach();
  });
});
