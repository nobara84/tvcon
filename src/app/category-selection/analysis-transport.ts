import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Source } from "../models/source";
import { ProviderCategory } from "./category-selection";

export interface AnalysisProgress {
  request_id: string;
  phase: "DOWNLOADING" | "ANALYZING" | "COMPLETE";
  processed_bytes: number;
  received_bytes: number;
  total_bytes: number | null;
  analyzed_entries: number;
  category_count: number;
  percentage: number | null;
}
@Injectable({ providedIn: "root" })
export class AnalysisTransport {
  subscribe(handler: (progress: AnalysisProgress) => void): Promise<UnlistenFn> {
    return listen<AnalysisProgress>("source-analysis-progress", event => handler(event.payload));
  }
  analyze(source: Source, requestId: string): Promise<ProviderCategory[]> {
    return invoke("analyze_source", { source, requestId });
  }
}
