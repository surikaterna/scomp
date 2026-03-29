import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket, ScompHeader } from './scomp';

/**
 * Event names exchanged between a scomp runtime and transport wire.
 */
export enum WireEvent {
  Request = 'req',
  Response = 'res',
  Connected = 'connected',
  Authenticated = 'authenticated'
}

/**
 * Transport contract used by legacy {@link Scomp} runtime.
 */
export default interface WireInterface extends EventEmitter2 {
  /** Sends a packet over the wire. */
  send<PacketType extends RequestPacket | ResponsePacket>(event: WireEvent, packet: PacketType, headers?: ScompHeader): void;
  /** Returns active transport connections when available. */
  getConnections(): any[];
}
