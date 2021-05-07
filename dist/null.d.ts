import { EventEmitter2 } from 'eventemitter2';
import WireInterface from './WireInterface';
/**
 * Wire responsible for transferring data，should keep connection alive or reconnect if necessary
 */
export default class NullWire extends EventEmitter2 implements WireInterface {
    send<T = any>(event: string, packet: T): void;
    _fromClient(event: string, packet: any): void;
}
