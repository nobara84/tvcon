import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { ViewMode } from '../models/viewMode';
import { EPG } from '../models/epg';

export type LibrarySection = 'live' | 'movies' | 'series' | 'favorites';

export function sectionFilters(filters: Filters, section: LibrarySection): Filters {
  const mediaTypes = section === 'favorites'
    ? [MediaType.livestream, MediaType.movie, MediaType.serie]
    : [section === 'live' ? MediaType.livestream : section === 'movies' ? MediaType.movie : MediaType.serie];
  return { ...filters, media_types: mediaTypes, view_type: section === 'favorites' ? ViewMode.Favorites : ViewMode.All,
    query: '', page: 1, group_id: undefined, series_id: undefined, season: undefined };
}

export function programmeSummary(epg: EPG[], now: number): { current?: EPG; next?: EPG } {
  return { current: epg.find(item => item.now_playing),
    next: epg.reduce<EPG | undefined>((next, item) =>
      item.start_timestamp > now && (!next || item.start_timestamp < next.start_timestamp) ? item : next, undefined) };
}
