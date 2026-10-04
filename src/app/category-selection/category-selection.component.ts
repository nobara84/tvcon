import { Component, Input, ViewChild, NgZone, Optional } from "@angular/core";
import localeDe from "@angular/common/locales/de";
import { registerLocaleData } from "@angular/common";
import { CommonModule } from "@angular/common";
import { ScrollingModule, CdkVirtualScrollViewport } from "@angular/cdk/scrolling";
import { AnalysisTransport, AnalysisProgress } from "./analysis-transport";
import { FormsModule } from "@angular/forms";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { invoke } from "@tauri-apps/api/core";
import { Source } from "../models/source";
import { SourceType } from "../models/sourceType";
import { CategorySelection, ProviderCategory, categoryKey, matchesLanguage } from "./category-selection";

registerLocaleData(localeDe);

interface Row { key: string; category: ProviderCategory; selection: CategorySelection; search: string; checked: boolean; }
interface Section { type: number; label: string; rows: Row[]; total: number; }

@Component({
  selector: "app-category-selection",
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule],
  templateUrl: "./category-selection.component.html",
  styleUrl: "./category-selection.component.css",
})
export class CategorySelectionComponent {
  @Input() source!: Source;
  @ViewChild(CdkVirtualScrollViewport) viewport?: CdkVirtualScrollViewport;
  onlySelected = false;
  activeType = 0;
  visibleRows: Row[] = [];
  analyzing = false;
  progress: AnalysisProgress | null = null;
  elapsedSeconds = 0;
  analysisRequestId: string | null = null;
  private unlisten?: () => void;
  private destroyed = false;
  busy = false;
  error = "";
  analyzed = false;
  query = "";
  allRows: Row[] = [];
  selected = new Map<string, CategorySelection>();
  importAll = false;
  totalEntries: number | null = null;
  selectedEntries: number | null = null;
  missingSelected = 0;
  sections: Section[] = [
    { type: 0, label: "LIVE", rows: [], total: 0 },
    { type: 1, label: "FILME", rows: [], total: 0 },
    { type: 2, label: "SERIEN", rows: [], total: 0 },
  ];
  constructor(public modal: NgbActiveModal, private transport: AnalysisTransport = new AnalysisTransport(), @Optional() private zone?: NgZone) {}

  ngOnDestroy() {
    this.destroyed = true;
    this.analysisRequestId = null;
    this.cleanupListener();
  }
  private cleanupListener() { this.unlisten?.(); this.unlisten = undefined; }
  handleProgress(progress: AnalysisProgress) {
    if (this.destroyed || !this.analyzing || progress.request_id !== this.analysisRequestId) return;
    this.progress = progress;
  }

  async ngOnInit() {
    this.busy = true;
    try {
      if (this.source.id !== undefined) {
        const saved = await invoke<CategorySelection[]>("get_source_category_selections", { sourceId: this.source.id });
        for (const selection of saved) this.selected.set(categoryKey(selection, this.source.source_type!), selection);
        this.importAll = saved.length === 0;
      } else this.importAll = true;
    } catch {
      this.error = "Gespeicherte Auswahl konnte nicht geladen werden. Bitte Dialog erneut öffnen.";
      this.busy = false;
      return;
    }
    this.busy = false;
    if (!this.destroyed) await this.analyze();
  }

  async analyze() {
    if (this.busy || this.destroyed) return;
    this.cleanupListener();
    this.busy = true;
    this.analyzing = true;
    this.progress = null;
    this.error = "";
    const requestId = crypto.randomUUID();
    this.analysisRequestId = requestId;
    const started = performance.now();
    try {
      const unlisten = await this.transport.subscribe(progress => {
        if (this.zone) this.zone.run(() => this.handleProgress(progress));
        else this.handleProgress(progress);
      });
      if (this.destroyed || this.analysisRequestId !== requestId) { unlisten(); return; }
      this.unlisten = unlisten;
      const categories = await this.transport.analyze(this.source, requestId);
      if (this.destroyed || this.analysisRequestId !== requestId) return;
      categories.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.media_type - b.media_type);
      this.allRows = categories.map(category => {
        const selection: CategorySelection = { category_name: category.name, media_type: category.media_type, provider_category_id: category.provider_category_id };
        const key = categoryKey(selection, this.source.source_type!);
        return { category, selection, key, search: (category.name ?? "Ohne Kategorie").toLocaleLowerCase(), checked: this.importAll || this.selected.has(key) };
      });
      // Keep saved identities absent from this response until explicitly deselected.
      if (this.importAll) this.selected.clear();
      for (const row of this.allRows) if (row.checked) this.selected.set(row.key, row.selection);
      this.importAll = false;
      this.analyzed = true;
      this.totalEntries = categories.every(c => c.entry_count !== null)
        ? categories.reduce((sum, c) => sum + c.entry_count!, 0) : null;
      this.filter();
      this.stats();
    } catch {
      if (this.destroyed || this.analysisRequestId !== requestId) return;
      this.error = "TVCon konnte die Quelle nicht analysieren. Datei oder Zugangsdaten prüfen und erneut versuchen.";
    } finally {
      if (this.analysisRequestId === requestId) {
        this.elapsedSeconds = (performance.now() - started) / 1000;
        this.busy = false;
        this.analyzing = false;
        this.analysisRequestId = null;
        this.cleanupListener();
      }
    }
  }

  filter(resetScroll = true) {
    const query = this.query.toLocaleLowerCase();
    for (const section of this.sections) {
      section.total = 0;
      section.rows = [];
    }
    for (const row of this.allRows) {
      const section = this.sections[row.category.media_type];
      if (!section) continue;
      section.total++;
      if (row.search.includes(query) && (!this.onlySelected || row.checked)) section.rows.push(row);
    }
    this.visibleRows = this.sections[this.activeType].rows;
    if (resetScroll) this.viewport?.scrollToIndex(0);
  }
  switchTab(type: number) {
    this.activeType = type;
    this.filter();
  }
  trackRow(_: number, row: Row) { return row.key; }
  toggle(row: Row, checked: boolean) {
    this.importAll = false;
    row.checked = checked;
    if (checked) this.selected.set(row.key, row.selection); else this.selected.delete(row.key);
    this.stats();
    if (this.onlySelected) this.filter(false);
  }
  choose(mode: "all" | "none" | "de" | "en") {
    this.importAll = false;
    if (mode === "all" || mode === "none") this.selected.clear();
    for (const row of this.allRows) {
      if (mode === "all" || mode === "none") row.checked = mode === "all";
      else if (matchesLanguage(row.category.name, mode)) row.checked = true;
      if (row.checked) this.selected.set(row.key, row.selection);
    }
    this.stats();
    if (this.onlySelected) this.filter();
  }
  clearFilter() { this.choose("all"); this.importAll = true; }
  stats() {
    let count = 0;
    let known = true;
    let matched = 0;
    for (const row of this.allRows) if (this.selected.has(row.key)) {
      matched++;
      if (row.category.entry_count === null) known = false;
      else count += row.category.entry_count;
    }
    this.missingSelected = this.selected.size - matched;
    this.selectedEntries = known && this.missingSelected === 0 ? count : null;
  }
  async save(importNow: boolean) {
    if (this.busy || !this.analyzed || (!this.importAll && this.selected.size === 0)) return;
    this.busy = true;
    this.error = "";
    try {
      const selections = this.importAll ? [] : [...this.selected.values()];
      if (this.source.id === undefined) {
        this.source.id = await invoke<number>("create_source_with_categories", { source: this.source, selections });
      } else {
        await invoke("update_source", { source: this.source });
        await invoke("set_source_category_selections", { sourceId: this.source.id, selections });
      }
      if (importNow) await invoke("import_source_categories", { sourceId: this.source.id });
      this.modal.close(this.source);
    } catch {
      this.error = "Speichern oder Importieren fehlgeschlagen. Eine bereits gespeicherte Auswahl bleibt erhalten; erneut versuchen.";
    } finally { this.busy = false; }
  }
}
