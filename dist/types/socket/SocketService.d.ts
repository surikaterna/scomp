/// <reference types="node" />
import EventEmitter from 'events';
export declare class SocketService extends EventEmitter {
    io: any;
    constructor(io: any);
    register(socket: any): void;
}
