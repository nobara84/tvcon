import { Injectable, OnDestroy } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
export interface NetworkStatus { state: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN'; interface?: string; public_ip?: string; }
@Injectable({ providedIn: 'root' })
export class NetworkStatusService implements OnDestroy {
  status: NetworkStatus = { state: 'UNKNOWN' };
  loading = false;
  private disposed = false;
  private timer = setInterval(() => void this.refresh(), 60000);
  constructor() { void this.refresh(); }
  query(): Promise<NetworkStatus> { return invoke('get_network_status'); }
  async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const status = await this.query();
      if (!this.disposed) this.status = status;
    } catch {
      if (!this.disposed) this.status = { state: 'UNKNOWN' };
    } finally { this.loading = false; }
  }
  ngOnDestroy() { this.disposed = true; clearInterval(this.timer); }
}
