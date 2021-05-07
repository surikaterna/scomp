import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket, ScompHeader } from '../scomp';
import { WireEvent } from '../WireInterface';
export interface ServerSocketWireConfig {
    server?: any;
    io?: any;
    bidirectional: boolean;
}
export default class ServerSocketWire extends EventEmitter2 {
    private io;
    private server;
    private nsp;
    private socketService;
    private _sockets;
    constructor(settings: ServerSocketWireConfig);
    _handleRequestPacket(packet: RequestPacket): void;
    _handleResponsePacket(packet: ResponsePacket): void;
    listen(): void;
    send(event: WireEvent, packet: ResponsePacket | RequestPacket, headers: ScompHeader): void;
}
