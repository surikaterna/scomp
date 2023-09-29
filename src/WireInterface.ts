import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket, ScompHeader } from './Scomp';

export enum WireEvent {
  Request = 'req',
  Response = 'res',
  Connected = 'connected',
  Authenticated = 'authenticated'
}

export default interface WireInterface extends EventEmitter2 {
  send<PacketType extends RequestPacket | ResponsePacket>(event: WireEvent, packet: PacketType, headers?: ScompHeader): void;
  getConnections(): any[];
}
