/// <reference types="socket.io-client" />
import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket } from '../scomp';
import { WireEvent } from '../WireInterface';
export interface ClientSocketWireConfig {
    socket?: SocketIOClient.Socket;
    address: string;
    bidirectional: boolean;
}
export default class ClientSocketWire extends EventEmitter2 {
    private socket;
    constructor(config: ClientSocketWireConfig);
    _handleRequestPacket(packet: RequestPacket): void;
    _handleResponsePacket(packet: ResponsePacket): void;
    send(event: WireEvent, packet: RequestPacket | ResponsePacket): void;
}
