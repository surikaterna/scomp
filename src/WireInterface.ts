import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket, ScompHeader } from './scomp';

export enum WireEvent {
  Request = 'req',
  Response = 'res'
}

export default interface WireInterface extends EventEmitter2 {
  send<PacketType extends RequestPacket | ResponsePacket>(event: WireEvent, packet: PacketType, headers?: ScompHeader): void;
}
