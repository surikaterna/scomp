import { Scomp, ResponsePacket, RequestPacket } from '../scomp';
export declare class ScompServer {
    private _scomp;
    private _servicePaths;
    constructor(scomp: Scomp);
    _controllerProxy(): () => void;
    _serverHandler(): {
        unsubscribe: (packet: ResponsePacket) => void;
    };
    /**
     * [
     *  {path: '/a/b', params: [ param1 ]}
     *  , {path: '/c/d' params: [ param2 ]
     * ]
     */
    _onRequestPacket(packet: RequestPacket): Promise<void>;
    _handleError(packet: RequestPacket, message: string, ...params: any[]): void;
    _observableUnsubscribe(packet: ResponsePacket): void;
    use<ServiceType = any>(path: string, obj: ServiceType, handler?: (obj: any, path: string) => any): void;
}
