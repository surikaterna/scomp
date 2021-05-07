/// <reference types="node" />
import { EventEmitter } from 'events';
import Observable from './Observable';
import { Path } from './util/PathProxyFactory';
import WireInterface from './WireInterface';
export { ScompServer } from './server/ScompServer';
export interface ScompHeader {
    socketId?: string;
}
export interface RequestPacket {
    id: string;
    paths?: Path[];
    path?: string;
    params: Array<any>;
}
export interface ResponsePacket<T = any> {
    id: string;
    res: T;
    sub?: {
        id: string;
        type: 'observable';
    };
    err?: Error | string;
}
export declare class Scomp extends EventEmitter {
    private _requests;
    private _responses;
    wire: WireInterface;
    constructor(wire: WireInterface);
    _onResponsePacket(packet: ResponsePacket): void;
    /**
     * Creates a new observable if not exists for packet.id
     */
    _handleObservablePacket(packet: ResponsePacket): void;
    _parseError(error?: Error | string): string | undefined;
    _unsubscribe(packet: ResponsePacket): void;
    unsubscribe(id: string): void;
    response(id: string, res: any | Observable, err?: Error): void;
    request(path: string | Path[], params: any, headers: ScompHeader): Promise<unknown>;
    _waitForResponse(id: string, resolve: (data?: any) => void, reject: (error: any) => void): void;
    _getObservable(id: string): Observable<any, Error>;
    client<ServerApiInterface = any>(headers?: ScompHeader): ServerApiInterface;
}
