import { sectionFilters, programmeSummary } from './library-state';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { ViewMode } from '../models/viewMode';
import { EPG } from '../models/epg';

describe('TVCon library navigation', () => {
  const filters: Filters = { source_ids: [7], media_types: [MediaType.movie], view_type: ViewMode.Hidden,
    query: 'old search', page: 256, group_id: 4, series_id: 5, season: 6, use_keywords: true };

  it('selects each provider media type without inventing series classification', () => {
    expect(sectionFilters(filters, 'live').media_types).toEqual([MediaType.livestream]);
    expect(sectionFilters(filters, 'movies').media_types).toEqual([MediaType.movie]);
    expect(sectionFilters(filters, 'series').media_types).toEqual([MediaType.serie]);
  });

  it('aggregates favorites through the existing view mode', () => {
    const result = sectionFilters(filters, 'favorites');
    expect(result.view_type).toBe(ViewMode.Favorites);
    expect(result.media_types).toEqual([MediaType.livestream, MediaType.movie, MediaType.serie]);
  });

  it('clears category, series, season, search and pagination on section changes', () => {
    const result = sectionFilters(filters, 'movies');
    expect(result.group_id).toBeUndefined();
    expect(result.series_id).toBeUndefined();
    expect(result.season).toBeUndefined();
    expect(result.query).toBe('');
    expect(result.page).toBe(1);
    expect(result.source_ids).toEqual([7]);
    expect(filters.page).toBe(256);
    expect(filters.group_id).toBe(4);
  });

  it('keeps absent programme data empty', () => {
    expect(programmeSummary([], 100)).toEqual({ current: undefined, next: undefined });
  });

  it('uses the provider current flag and earliest future programme without sorting the input', () => {
    const epg = [ { title: 'Later', start_timestamp: 300 }, { title: 'Now', start_timestamp: 50, now_playing: true },
      { title: 'Next', start_timestamp: 150 }, { title: 'Old', start_timestamp: 10 } ] as EPG[];
    const result = programmeSummary(epg, 100);
    expect(result.current?.title).toBe('Now');
    expect(result.next?.title).toBe('Next');
    expect(epg[0].title).toBe('Later');
  });
});
