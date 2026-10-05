import { HomeComponent } from './home.component';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { ViewMode } from '../models/viewMode';
import { Stack } from '../models/stack';

describe('TVCon home view state', () => {
  let home: HomeComponent;
  beforeEach(() => {
    // Exercise state without starting Tauri IPC, source loading or a browser player.
    home = Object.create(HomeComponent.prototype);
    Object.assign(home, { filters: { source_ids: [1], media_types: [MediaType.livestream],
      view_type: ViewMode.All, page: 1, use_keywords: false } as Filters,
      memory: { Sources: new Map([[1, {}]]), XtreamSourceIds: new Set() }, nodeStack: new Stack(),
      channels: [], movieColumns: 6, section: "live", categoryPage: 1, libraryRequest: 0, categoryRequest: 0, epgRequest: 0, PAGE_SIZE: 36,
      error: { handleError: jasmine.createSpy('handleError') } });
  });

  it('switches navigation and reloads only bounded backend views', async () => {
    spyOn(home, 'load').and.resolveTo();
    spyOn(home, 'loadCategories').and.resolveTo();
    await home.selectSection('movies');
    expect(home.section).toBe('movies');
    expect(home.filters?.media_types).toEqual([MediaType.movie]);
    expect(home.load).toHaveBeenCalledTimes(1);
    expect(home.loadCategories).toHaveBeenCalledTimes(1);
    await home.selectSection('favorites');
    expect(home.filters?.view_type).toBe(ViewMode.Favorites);
    expect(home.filters?.media_types.length).toBe(3);
  });

  it('uses the selected group in backend search while preserving favorites', async () => {
    home.section = 'favorites';
    spyOn(home, 'load').and.resolveTo();
    const category = { id: 12, name: 'Category' };
    await home.selectCategory(category);
    expect(home.selectedCategory).toBe(category);
    expect(home.filters?.group_id).toBe(12);
    expect(home.filters?.view_type).toBe(ViewMode.Favorites);
  });

  it('replaces a page instead of accumulating an entire library', async () => {
    const page = Array.from({ length: 36 }, (_, id) => ({ id: id + 36 }));
    home.channels = [{ id: 1 }];
    const query = spyOn(home, 'queryChannels').and.resolveTo(page);
    await home.load(true);
    expect(home.channels).toBe(page);
    expect(home.channels.length).toBe(36);
    expect(home.filters?.page).toBe(2);
    expect(query.calls.mostRecent().args[0].page).toBe(2);
    expect(home.reachedMax).toBeFalse();
  });

  it('discards an older response after a more recent navigation request', async () => {
    let complete!: (channels: Channel[]) => void;
    spyOn(home, 'queryChannels').and.returnValues(new Promise(resolve => complete = resolve), Promise.resolve([{ id: 2 }]));
    const old = home.load();
    await home.load();
    complete([{ id: 1 }]);
    await old;
    expect(home.channels).toEqual([{ id: 2 }]);
    expect(home.loading).toBeFalse();
  });

  it('loads further category batches without changing movie pagination', async () => {
    spyOn(home, 'queryChannels').and.resolveTo([{ id: 10 }]);
    await home.loadCategories(2);
    expect(home.categoryPage).toBe(2);
    expect(home.filters?.page).toBe(1);
    expect(home.categoryEnd).toBeTrue();
    expect(home.categories).toEqual([{ id: 10 }]);
  });

  it('clears stale content if a query for the new view fails', async () => {
    home.channels = [{ id: 1 }];
    spyOn(home, 'queryChannels').and.rejectWith('test failure');
    await home.load();
    expect(home.channels).toEqual([]);
    expect(home.reachedMax).toBeTrue();
    expect(home.loading).toBeFalse();
  });

  it('provides an honest no-EPG state for M3U without making an EPG request', async () => {
    await home.selectChannel({ id: 1, media_type: MediaType.livestream, source_id: 1 });
    expect(home.epgLoading).toBeFalse();
    expect(home.currentProgramme).toBeUndefined();
    expect(home.nextProgramme).toBeUndefined();
    expect(home.epgMessage).toContain('keine Programmdaten');
  });
});

describe('incremental movie library', () => {
  let home: HomeComponent;
  beforeEach(() => {
    home = Object.create(HomeComponent.prototype);
    Object.assign(home, { section:'movies', movieColumns:6, channels:[], movieRows:[], PAGE_SIZE:36,
      filters:{source_ids:[1], media_types:[MediaType.movie], view_type:ViewMode.All, page:1},
      libraryRequest:0, nodeStack:new Stack(), memory:{Sources:new Map([[1,{}]])},
      error:{handleError:jasmine.createSpy()} });
  });
  it('loads first batch, appends unique records and stops at end', async () => {
    spyOn(home,'queryChannels').and.returnValues(Promise.resolve(Array.from({length:36},(_,id)=>({id}))), Promise.resolve([{id:35},{id:36}]));
    await home.load();
    expect(home.channels.length).toBe(36);
    await home.loadMore();
    expect(home.channels.length).toBe(37);
    expect(home.reachedMax).toBeTrue();
    await home.loadMore();
    expect(home.queryChannels).toHaveBeenCalledTimes(2);
  });
  it('clears immediately on category change and discards old append', async () => {
    home.channels=[{id:1}];
    let resolve!: (channels:Channel[])=>void;
    spyOn(home,'queryChannels').and.returnValues(new Promise(r=>resolve=r), Promise.resolve([{id:3}]));
    const old=home.load(true);
    await home.selectCategory({id:8});
    resolve([{id:2}]); await old;
    expect(home.channels).toEqual([{id:3}]);
    expect(home.filters?.page).toBe(1);
  });
  it('resets on changed search and avoids overlapping append', async () => {
    let resolve!: (channels:Channel[])=>void;
    spyOn(home,'queryChannels').and.returnValue(new Promise(r=>resolve=r));
    home.filters!.query='new';
    home.channels=[{id:1}];
    const load=home.load();
    expect(home.channels).toEqual([]);
    await home.loadMore();
    expect(home.queryChannels).toHaveBeenCalledTimes(1);
    resolve([]); await load;
    expect(home.reachedMax).toBeTrue();
  });
});

describe('category navigation window', () => {
  it('loads only near the rendered boundary and uses backend category search', async () => {
    const home = Object.create(HomeComponent.prototype) as HomeComponent;
    Object.assign(home, { categories:Array.from({length:100},(_,id)=>({id})), categoryPage:1,
      categoryQuery:'Action', categoryRequest:0, PAGE_SIZE:36,
      filters:{source_ids:[1],media_types:[MediaType.movie],view_type:ViewMode.All,page:8},
      memory:{Sources:new Map([[1,{}]])}, error:{handleError:jasmine.createSpy()} });
    const query=spyOn(home,'queryChannels').and.resolveTo([{id:500}]);
    home.categoryScrolled(0); expect(query).not.toHaveBeenCalled();
    await home.loadCategories();
    expect(query.calls.mostRecent().args[0].query).toBe('Action');
    expect(query.calls.mostRecent().args[0].view_type).toBe(ViewMode.Categories);
    expect(home.filters?.page).toBe(8);
    expect(home.categories).toEqual([{id:500}]);
  });
});
