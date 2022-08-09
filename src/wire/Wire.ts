import Observable from '../observable/Observable';

export default interface Wire {
  connected: Observable<boolean>;
  incomingPackets: Observable<WireResponse>;
  request(packet: WireRequest): void;
  close(): void;
}
