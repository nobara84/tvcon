import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { AllowIn, ShortcutInput } from "ng-keyboard-shortcuts";
import {
  Subscription,
  debounceTime,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  skip,
} from "rxjs";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { ViewMode } from "../models/viewMode";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { FocusArea, FocusAreaPrefix } from "../models/focusArea";
import { invoke } from "@tauri-apps/api/core";
import { Source } from "../models/source";
import { Filters } from "../models/filters";
import { SourceType } from "../models/sourceType";
import { animate, state, style, transition, trigger } from "@angular/animations";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SortType } from "../models/sortType";
import { getVersion } from "@tauri-apps/api/app";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { WhatsNewModalComponent } from "../whats-new-modal/whats-new-modal.component";
import { LAST_SEEN_VERSION } from "../models/localStorage";
import { isInputFocused } from "../utils";
import { Node } from "../models/node";
import { NodeType } from "../models/nodeType";
import { Stack } from "../models/stack";

import { CdkVirtualScrollViewport } from "@angular/cdk/scrolling";
import { EPG } from "../models/epg";
import { LibrarySection, sectionFilters, programmeSummary } from "./library-state";

import { NetworkStatusService } from "../network-status.service";

import { BulkActionType } from '../models/bulkActionType';

@Component({
  selector: "app-home",
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.css",
  animations: [
    trigger("fadeInOut", [
      transition(":enter", [
        style({ opacity: 0, height: 0, padding: "0", margin: "0" }),
        animate("250ms", style({ opacity: 1, height: "*", padding: "*", margin: "*" })),
      ]),
      transition(":leave", [
        style({ opacity: 1, height: "*", padding: "*", margin: "*" }),
        animate("250ms", style({ opacity: 0, height: 0, padding: "0", margin: "0" })),
      ]),
    ]),
    trigger("fade", [
      state(
        "visible",
        style({
          opacity: 1,
        }),
      ),
      state(
        "hidden",
        style({
          opacity: 0,
        }),
      ),
      transition("visible => hidden", [animate("250ms ease-out")]),
      transition("hidden => visible", [animate("250ms ease-in")]),
    ]),
  ],
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  channels: Channel[] = [];
  section: LibrarySection = "live";
  categories: Channel[] = [];
  movieRows: Channel[][] = [];
  movieColumns = 6;
  movieRowHeight = 370;
  private movieResize?: ResizeObserver;
  private movieViewport?: CdkVirtualScrollViewport;
  @ViewChild("movieViewport") set movieView(view: CdkVirtualScrollViewport | undefined) {
    this.movieResize?.disconnect();
    this.movieViewport = view;
    if (view) {
      this.movieResize = new ResizeObserver(entries => {
        const width = entries[0].contentRect.width;
        const posterWidth = Math.min(420, Math.max(180, window.innerWidth * 0.11));
        this.movieColumns = Math.max(1, Math.floor(width / posterWidth));
        this.movieRowHeight = Math.round(((width - (this.movieColumns - 1) * 16 - 8) / this.movieColumns) * 1.5 + 78);
        this.buildMovieRows();
        view.checkViewportSize();
      });
      this.movieResize.observe(view.elementRef.nativeElement);
    }
  }
  buildMovieRows() {
    this.movieRows = [];
    for (let i = 0; i < this.channels.length; i += this.movieColumns)
      this.movieRows.push(this.channels.slice(i, i + this.movieColumns));
  }
  movieScrolled(index: number) {
    if (this.destroyed || this.section !== "movies") return;
    if (index + Math.ceil((this.movieViewport?.getViewportSize() || 700) / (this.movieRowHeight || 370)) + 2 >= this.movieRows.length)
      void this.loadMore();
  }
  categoryScrolled(index: number) {
    if (this.destroyed) return;
    if (index + Math.ceil((this.categoryViewport?.getViewportSize() || 700) / 44) + 8 >= this.categories.length)
      void this.loadCategories(this.categoryPage + 1);
  }
  categoryQuery = "";
  categoryPage = 1;
  categoryEnd = false;
  categoryLoading = false;
  selectedCategory?: Channel;
  selectedChannel?: Channel;
  selectedArtwork = true;
  currentProgramme?: EPG;
  nextProgramme?: EPG;
  epgLoading = false;
  epgMessage = "";
  private destroyed = false;
  private libraryRequest = 0;
  private categoryRequest = 0;
  private epgRequest = 0;
  @ViewChild("categoryViewport") categoryViewport?: CdkVirtualScrollViewport;

  async selectSection(section: LibrarySection) {
    if (!this.filters) return;
    this.section = section;
    this.filters = sectionFilters(this.filters, section);
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.chkLiveStream = this.filters.media_types.includes(MediaType.livestream);
    this.chkMovie = this.filters.media_types.includes(MediaType.movie);
    this.chkSerie = this.filters.media_types.includes(MediaType.serie);
    this.nodeStack.clear();
    this.selectedCategory = undefined;
    this.selectedChannel = undefined;
    this.epgRequest++;
    this.clearSearch();
    this.categoryQuery = "";
    await Promise.all([this.load(), this.loadCategories()]);
  }

  async loadCategories(page = 1) {
    if (!this.filters) return;
    if (page > 1 && (this.categoryLoading || this.categoryEnd)) return;
    const request = ++this.categoryRequest;
    if (page === 1) { this.categories = []; this.categoryEnd = false; this.categoryPage = 1; }
    this.categoryLoading = true;
    const filters: Filters = { ...this.filters, source_ids: Array.from(this.memory.Sources.keys()),
      view_type: ViewMode.Categories, page, query: this.categoryQuery,
      group_id: undefined, series_id: undefined, season: undefined, use_keywords: false };
    try {
      const categories = await this.queryChannels(filters);
      if (request !== this.categoryRequest) return;
      this.categories = page === 1 ? categories : [...this.categories, ...categories.filter(c => !this.categories.some(old => old.id === c.id))];
      this.categoryPage = page;
      this.categoryEnd = categories.length < this.PAGE_SIZE;
      if (page === 1) this.categoryViewport?.scrollToIndex(0);
    } catch (e) {
      if (request === this.categoryRequest) {
        this.categories = [];
        this.categoryEnd = true;
        this.error.handleError(e);
      }
    } finally {
      if (request === this.categoryRequest) {
        this.categoryLoading = false;
        if (!this.categoryEnd) setTimeout(() => this.categoryScrolled(this.categoryViewport?.getRenderedRange().start || 0));
      }
    }
  }

  async selectCategory(category?: Channel) {
    if (!this.filters) return;
    this.selectedCategory = category;
    this.filters.group_id = category?.id;
    this.filters.series_id = undefined;
    this.filters.season = undefined;
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.filters.view_type = this.section === "favorites" ? ViewMode.Favorites : ViewMode.All;
    this.nodeStack.clear();
    this.clearSearch();
    await this.load();
  }

  async selectChannel(channel: Channel) {
    this.selectedChannel = channel;
    this.selectedArtwork = true;
    this.currentProgramme = this.nextProgramme = undefined;
    this.epgMessage = "";
    const request = ++this.epgRequest;
    this.epgLoading = false;
    if (channel.media_type !== MediaType.livestream || !this.memory.XtreamSourceIds.has(channel.source_id!)) {
      this.epgMessage = "Für diesen Sender sind keine Programmdaten verfügbar.";
      return;
    }
    this.epgLoading = true;
    try {
      const epg = await invoke<EPG[]>("get_epg", { channel });
      if (request !== this.epgRequest) return;
      const summary = programmeSummary(epg, Date.now() / 1000);
      this.currentProgramme = summary.current;
      this.nextProgramme = summary.next;
      if (!summary.current && !summary.next) this.epgMessage = "Keine aktuellen Programmdaten verfügbar.";
    } catch {
      if (request === this.epgRequest) this.epgMessage = "Programmdaten konnten nicht geladen werden.";
    } finally {
      if (request === this.epgRequest) this.epgLoading = false;
    }
  }

  trackChannel(index: number, channel: Channel) { return channel.id ?? index; }

  queryChannels(filters: Filters): Promise<Channel[]> { return invoke("search", { filters }); }

  async previousPage() {
    if (this.filters && this.filters.page > 1 && !this.loading) await this.load(false, this.filters.page - 1);
  }
  readonly viewModeEnum = ViewMode;
  bulkActionType = BulkActionType;
  readonly mediaTypeEnum = MediaType;
  @ViewChild("search") search!: ElementRef;
  shortcuts: ShortcutInput[] = [];
  focus: number = 0;
  focusArea = FocusArea.Tiles;
  viewType = ViewMode.All;
  subscriptions: Subscription[] = [];
  filters?: Filters;
  chkLiveStream = true;
  chkMovie = true;
  chkSerie = true;
  reachedMax = false;
  readonly PAGE_SIZE = 36;
  channelsVisible = true;
  prevSearchValue: String = "";
  loading = false;
  nodeStack: Stack = new Stack();

  constructor(
    public network: NetworkStatusService,
    private router: Router,
    public memory: MemoryService,
    public toast: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
  ) {
    this.getSources();
  }

  getSources() {
    let get_settings = invoke("get_settings");
    let get_sources = invoke("get_sources");
    Promise.all([get_settings, get_sources])
      .then((data) => {
        let settings = data[0] as Settings;
        let sources = data[1] as Source[];
        if (settings.zoom) getCurrentWebview().setZoom(Math.trunc(settings.zoom! * 100) / 10000);
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map(s => [s.id!, s]));
        if (sources.length == 0) this.reset();
        else {
          getVersion().then((version) => {
            if (localStorage.getItem(LAST_SEEN_VERSION) != version) {
              this.memory.AppVersion = version;
              this.memory.ModalRef = this.modal.open(WhatsNewModalComponent, {
                backdrop: "static",
                size: "xl",
                keyboard: false,
              });
              this.memory.ModalRef.componentInstance.name = "WhatsNewModal";
            }
          });
          sources
            .filter((x) => x.source_type == SourceType.Custom)
            .map((x) => x.id!)
            .forEach((x) => this.memory.CustomSourceIds?.add(x));
          sources
            .filter((x) => x.source_type == SourceType.Xtream)
            .map((x) => x.id!)
            .forEach((x) => this.memory.XtreamSourceIds.add(x));
          if (
            this.memory.XtreamSourceIds.size > 0 &&
            !sessionStorage.getItem("epgCheckedOnStart")
          ) {
            sessionStorage.setItem("epgCheckedOnStart", "true");
            invoke("on_start_check_epg");
          }
          this.filters = {
            source_ids: Array.from(this.memory.Sources.keys()),
            view_type: settings.default_view ?? ViewMode.All,
            media_types: [MediaType.livestream],
            page: 1,
            use_keywords: false,
            sort: SortType.provider,
          };
          if (settings.default_sort != undefined && settings.default_sort != SortType.provider) {
            this.memory.Sort.next([settings.default_sort, false]);
            this.filters.sort = settings.default_sort;
          }
          this.section = this.filters.view_type === ViewMode.Favorites ? "favorites" : "live";
          if (this.section === "favorites") this.filters.media_types = [MediaType.livestream, MediaType.movie, MediaType.serie];
          this.chkLiveStream = true;
          this.chkMovie = this.section === "favorites";
          this.chkSerie = this.section === "favorites";
          this.loadCategories();
          if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
            sessionStorage.setItem("refreshedOnStart", "true");
            this.refreshOnStart().then((_) => _);
          }
          this.load().then((_) => _);
        }
      })
      .catch((e) => {
        this.error.handleError(e);
        this.reset();
      });
  }

  async refreshOnStart() {
    this.toast.info("Refreshing all sources... (refresh on start enabled)");
    await this.memory.tryIPC(
      "Successfully refreshed all sources (refresh on start enabled)",
      "Failed to refresh all sources (refresh on start enabled)",
      async () => {
        await invoke("refresh_all");
      },
    );
  }

  async reload() {
    await Promise.all([this.load(), this.loadCategories()]);
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  async addEvents() {
    this.subscriptions.push(
      this.memory.HideChannels.subscribe((val) => {
        this.channelsVisible = val;
      }),
    );
    this.subscriptions.push(
      this.memory.SetFocus.subscribe((focus) => {
        if (focus >= 0) this.focus = focus;
      }),
    );
    this.subscriptions.push(
      this.memory.SetNode.subscribe(async (dto) => {
        this.nodeStack.add(
          new Node(
            dto.id,
            dto.name,
            dto.type,
            this.filters?.query,
            this.filters?.view_type,
          ),
        );
        if (dto.type == NodeType.Category) { this.filters!.group_id = dto.id; this.selectedCategory = { id: dto.id, name: dto.name }; }
        else if (dto.type == NodeType.Series) {
          this.filters!.series_id = dto.id;
          this.filters!.source_ids = [dto.sourceId!];
        } else if (dto.type == NodeType.Season) this.filters!.season = dto.id;

        if (this.filters!.view_type == ViewMode.Hidden) {
          this.filters!.view_type = ViewMode.Categories;
        }

        this.clearSearch();
        await this.load();
        if (this.focusArea == FocusArea.Tiles) this.selectFirstChannelDelayed(100);
      }),
    );
    this.subscriptions.push(
      this.memory.Refresh.subscribe((scroll) => {
        this.load();
        this.loadCategories();
        if(scroll)
          window.scrollTo({ top: 0, behavior: "instant" });
      }),
    );
    this.subscriptions.push(
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters!.sort = sort;
        await this.load();
      }),
    );
  }

  clearSearch() {
    if (this.search) this.search.nativeElement.value = "";
    this.prevSearchValue = "";
    this.filters!.query = "";
  }

  async loadMore() {
    if (!this.loading && !this.reachedMax) await this.load(true);
  }

  async load(more = false, page?: number) {
    if (!this.filters) return;
    if (more && this.loading) return;
    const request = ++this.libraryRequest;
    if (!more) {
      this.channels = []; this.buildMovieRows(); this.reachedMax = false;
      this.movieViewport?.scrollToIndex(0);
    }
    const requestedPage = page ?? (more ? this.filters.page + 1 : 1);
    const filters = { ...this.filters, media_types: [...this.filters.media_types], page: requestedPage };
    this.loading = true;
    try {
      const channels = await this.queryChannels(filters);
      if (request !== this.libraryRequest) return;
      this.channels = more && this.section === 'movies'
        ? [...this.channels, ...channels.filter(c => !this.channels.some(old => old.id === c.id))] : channels;
      this.buildMovieRows();
      if (this.selectedChannel && !this.channels.some(channel => channel.id === this.selectedChannel?.id)) {
        this.selectedChannel = undefined;
        this.epgRequest++;
      }
      this.filters.page = requestedPage;
      this.channelsVisible = true;
      this.viewType = filters.view_type;
      this.reachedMax = channels.length < this.PAGE_SIZE;
      if (!more) this.focus = 0;
      if (this.section === 'movies' && !this.reachedMax)
        setTimeout(() => this.movieScrolled(this.movieViewport?.getRenderedRange().start || 0));
    } catch (e) {
      if (request === this.libraryRequest) {
        this.channels = [];
        this.selectedChannel = undefined;
        this.epgRequest++;
        this.reachedMax = true;
        this.error.handleError(e);
      }
    } finally {
      if (request === this.libraryRequest) this.loading = false;
    }
  }

  ngAfterViewInit(): void {
    this.addEvents().then((_) => _);
    this.subscriptions.push(
      fromEvent(this.search.nativeElement, "keyup")
        .pipe(
          filter((event: any) => event.key !== "Escape"),
          map((event: any) => {
            this.focus = 0;
            this.focusArea = FocusArea.Tiles;
            if (this.channelsVisible && event.target.value != this.prevSearchValue)
              this.channelsVisible = false;
            if (event.target.value !== this.prevSearchValue) {
              this.libraryRequest++;
              this.loading = false;
              this.channels = []; this.buildMovieRows();
            }
            this.prevSearchValue = event.target.value;
            return event.target.value;
          }),
          debounceTime(300),
        )
        .subscribe(async (term: string) => {
          if (!this.filters || term !== this.search.nativeElement.value) return;
          this.filters.query = term;
          await this.load();
        }),
    );

    this.shortcuts.push(
      {
        key: ["ctrl + f", "ctrl + space", "cmd + f"],
        label: "Search",
        description: "Go to search",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: (_) => this.focusSearch(),
      },
      {
        key: ["ctrl + a", "cmd + a"],
        label: "Switching modes",
        description: "Selects the all channels view",
        preventDefault: true,
        command: async (_) => await this.switchMode(this.viewModeEnum.All),
      },
      {
        key: ["ctrl + s", "cmd + s"],
        label: "Switching modes",
        description: "Selects the categories view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Categories),
      },
      {
        key: ["ctrl + d", "cmd + d"],
        label: "Switching modes",
        description: "Selects the history view",
        command: async (_) => await this.switchMode(this.viewModeEnum.History),
      },
      {
        key: ["ctrl + r", "cmd + r"],
        label: "Switching modes",
        description: "Selects the favorites view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Favorites),
      },
      {
        key: "ctrl + q",
        label: "Media Type Filters",
        description: "Enable/Disable livestreams",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkLiveStream = !this.chkLiveStream;
          this.updateMediaTypes(MediaType.livestream);
        },
      },
      {
        key: "ctrl + w",
        label: "Media Type Filters",
        description: "Enable/Disable movies",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkMovie = !this.chkMovie;
          this.updateMediaTypes(MediaType.movie);
        },
      },
      {
        key: "ctrl + e",
        label: "Media Type Filters",
        description: "Enable/Disable series",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkSerie = !this.chkSerie;
          this.updateMediaTypes(MediaType.serie);
        },
      },
      {
        key: "left",
        label: "Navigation",
        description: "Go left",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowLeft"),
      },
      {
        key: "right",
        label: "Navigation",
        description: "Go right",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowRight"),
      },
      {
        key: "up",
        label: "Navigation",
        description: "Go up",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowUp"),
      },
      {
        key: "down",
        label: "Navigation",
        description: "Go down",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowDown"),
      },
    );
  }

  updateMediaTypes(mediaType: MediaType) {
    let index = this.filters!.media_types.indexOf(mediaType);
    if (index == -1) this.filters!.media_types.push(mediaType);
    else this.filters!.media_types.splice(index, 1);
    this.load();
    this.loadCategories();
  }

  filtersVisible() {
    return !this.filters?.series_id;
  }

  async switchMode(viewMode: ViewMode) {
    if (!this.filters) return;
    if (viewMode === ViewMode.Favorites) { await this.selectSection("favorites"); return; }
    if (viewMode == this.filters?.view_type) return;
    this.selectedCategory = undefined;
    if (this.section === "favorites") {
      this.section = "live";
      this.filters.media_types = [MediaType.livestream];
      this.chkLiveStream = true;
      this.chkMovie = this.chkSerie = false;
      this.loadCategories();
    }
    this.filters!.source_ids = Array.from(this.memory.Sources.keys());
    this.filters!.series_id = undefined;
    this.filters!.group_id = undefined;
    this.filters!.view_type = viewMode;
    this.filters!.season = undefined;
    this.clearSearch();
    this.nodeStack.clear();
    await this.load();
  }

  searchFocused(): boolean {
    return document.activeElement?.id == "search";
  }

  focusSearch() {
    if (this.searchFocused()) {
      this.selectFirstChannel();
      return;
    } else {
      this.focus = 0;
      this.focusArea = FocusArea.Tiles;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    this.search.nativeElement.focus({
      preventScroll: true,
    });
  }

  async goBackHotkey() {
    if (this.memory.ModalRef) {
      if (
        this.memory.ModalRef.componentInstance.name != "RestreamModalComponent" ||
        !this.memory.ModalRef.componentInstance.started
      )
        this.memory.ModalRef.close("close");
      return;
    } else if (this.memory.currentContextMenu?.menuOpen) {
      this.closeContextMenu();
    } else if (this.searchFocused()) {
      this.selectFirstChannel();
    } else if (this.filters?.query) {
      if (this.filters?.query) {
        this.clearSearch();
        await this.load();
      }
      this.selectFirstChannelDelayed(100);
    } else if (this.nodeStack.hasNodes()) {
      await this.goBack();
      this.selectFirstChannelDelayed(100);
    } else {
      this.selectFirstChannel();
    }
  }

  selectFirstChannelDelayed(milliseconds: number) {
    setTimeout(() => this.selectFirstChannel(), milliseconds);
  }

  async goBack() {
    var node = this.nodeStack.pop();
    if (node.type == NodeType.Category) { this.filters!.group_id = undefined; this.selectedCategory = undefined; }
    else if (node.type == NodeType.Series) {
      this.filters!.series_id = undefined;
      this.filters!.source_ids = Array.from(this.memory.Sources.keys());
    } else if (node.type == NodeType.Season) {
      this.filters!.season = undefined;
    }
    if (node.query) {
      this.search.nativeElement.value = node.query;
      this.filters!.query = node.query;
    }
    if (node.fromViewType !== undefined && this.filters!.view_type !== node.fromViewType) {
      this.filters!.view_type = node.fromViewType;
    }
    await this.load();
  }

  openSettings() {
    this.router.navigateByUrl("settings");
  }

  async nav(key: string) {
    if (this.searchFocused()) return;
    const columns = this.section === "movies" ? this.movieColumns : this.section === "live" ? 1 : (window.innerWidth < 600 ? 1 : window.innerWidth < 900 ? 2 : 3);
    if (this.memory.currentContextMenu?.menuOpen || this.memory.ModalRef) {
      return;
    }
    let tmpFocus = 0;
    switch (key) {
      case "ArrowUp":
        tmpFocus -= columns;
        break;
      case "ArrowDown":
        tmpFocus += columns;
        break;
      case "ShiftTab":
      case "ArrowLeft":
        tmpFocus -= 1;
        break;
      case "Tab":
      case "ArrowRight":
        tmpFocus += 1;
        break;
    }
    let goOverSize = this.shortFiltersMode() ? 1 : 2;
    tmpFocus += this.focus;
    if (tmpFocus < 0) {
      this.changeFocusArea(false);
    } else if (tmpFocus > goOverSize && this.focusArea == FocusArea.Filters) {
      this.changeFocusArea(true);
    } else if (tmpFocus > 4 && this.focusArea == FocusArea.ViewMode) {
      this.changeFocusArea(true);
    } else if (
      this.focusArea == FocusArea.Tiles &&
      tmpFocus >= this.channels.length &&
      !this.reachedMax
    )
      { await this.loadMore(); this.selectFirstChannelDelayed(0); }
    else {
      if (tmpFocus >= this.channels.length && this.focusArea == FocusArea.Tiles)
        tmpFocus = (this.channels.length == 0 ? 1 : this.channels.length) - 1;
      this.focus = tmpFocus;
      if (this.section === 'movies' && this.focusArea === FocusArea.Tiles)
        this.movieViewport?.scrollToIndex(Math.floor(this.focus / this.movieColumns));
      setTimeout(() => {
        document.getElementById(`${FocusAreaPrefix[this.focusArea]}${this.focus}`)?.focus();
      }, 0);
    }
  }

  shortFiltersMode() {
    return this.filters?.source_ids.findIndex((x) => this.memory.XtreamSourceIds.has(x)) == -1;
  }

  anyXtream() {
    return Array.from(this.memory.Sources.values()).findIndex((x) => x.source_type == SourceType.Xtream) != -1;
  }

  changeFocusArea(down: boolean) {
    let increment = down ? 1 : -1;
    this.focusArea += increment;
    if (this.focusArea == FocusArea.Filters && !this.filtersVisible()) this.focusArea += increment;
    if (this.focusArea < 0) this.focusArea = 0;
    this.applyFocusArea(down);
  }

  applyFocusArea(down: boolean) {
    if (this.focusArea === FocusArea.Filters) {
      const details = document.querySelector<HTMLDetailsElement>(".tools details");
      if (details) details.open = true;
    }
    this.focus = down
      ? 0
      : this.focusArea == FocusArea.Filters
        ? this.shortFiltersMode()
          ? 1
          : 2
        : 4;
    let id = FocusAreaPrefix[this.focusArea] + this.focus;
    document.getElementById(id)?.focus();
  }

  //Temporary solution because the ng-keyboard-shortcuts library doesn't seem to support ESC
  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !isInputFocused())
    ) {
      this.goBackHotkey();
      event.preventDefault();
    }
    if (event.key == "Tab" && !this.memory.ModalRef && document.activeElement?.id.startsWith("tile-")) {
      event.preventDefault();
      this.nav(event.shiftKey ? "ShiftTab" : "Tab");
    }
    if (event.key == "Enter" && this.focusArea == FocusArea.Filters)
      (document.activeElement as any).click();
  }

  selectFirstChannel() {
    this.focusArea = FocusArea.Tiles;
    this.focus = 0;
    (document.getElementById("first")?.firstChild as HTMLElement)?.focus();
  }

  closeContextMenu() {
    if (this.memory.currentContextMenu?.menuOpen) {
      this.memory.currentContextMenu?.closeMenu();
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.movieResize?.disconnect();
    this.libraryRequest++;
    this.categoryRequest++;
    this.epgRequest++;
    this.subscriptions.forEach((x) => x.unsubscribe());
  }

  async toggleKeywords() {
    this.filters!.use_keywords = !this.filters!.use_keywords;
    await this.load();
  }

  async bulkAction(action: BulkActionType) {
    if (this.filters?.series_id && !this.filters?.season) {
      return;
    }
    const actionName = BulkActionType[action].toLowerCase();
    try {
      await invoke("bulk_update", { filters: this.filters, action: action });
      await this.load();
      this.toast.success(`Successfully executed bulk update: ${actionName}`);
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
