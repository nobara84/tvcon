import { fakeAsync, tick } from '@angular/core/testing';
import { NetworkStatusService, NetworkStatus } from './network-status.service';
describe('network indicator', () => {
  it('preserves local state with or without public IP and handles failure', async () => {
    spyOn(NetworkStatusService.prototype, 'query').and.resolveTo({state:'ACTIVE', public_ip:'185.1.2.3'});
    const service = new NetworkStatusService();
    await Promise.resolve();
    expect(service.status.state).toBe('ACTIVE');
    (service.query as jasmine.Spy).and.resolveTo({state:'INACTIVE',public_ip:'185.1.2.3'});
    await service.refresh(); expect(service.status.state).toBe('INACTIVE');
    (service.query as jasmine.Spy).and.resolveTo({state:'ACTIVE'});
    await service.refresh(); expect(service.status).toEqual({state:'ACTIVE'});
    (service.query as jasmine.Spy).and.rejectWith('failure');
    await service.refresh(); expect(service.status.state).toBe('UNKNOWN');
    service.ngOnDestroy();
  });
  it('refreshes conservatively, prevents overlap and discards results after disposal', fakeAsync(() => {
    let resolve!: (value:NetworkStatus)=>void;
    const query=spyOn(NetworkStatusService.prototype,'query').and.returnValue(new Promise(r=>resolve=r));
    const service=new NetworkStatusService();
    tick(60000); expect(query).toHaveBeenCalledTimes(1);
    resolve({state:'UNKNOWN',public_ip:'1.2.3.4'}); tick();
    expect(service.status.state).toBe('UNKNOWN');
    tick(60000); expect(query).toHaveBeenCalledTimes(2);
    service.ngOnDestroy(); resolve({state:'ACTIVE'}); tick(60000);
    expect(service.status.state).toBe('UNKNOWN');
    expect(query).toHaveBeenCalledTimes(2);
  }));
});
