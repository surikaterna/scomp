import { Scomp } from '../scomp';
export declare class ScompServer {
    private _scomp;
    private _servicePaths;
    constructor(scomp: Scomp);
    private _controllerProxy;
    private _serverHandler;
    /**
     * [
     *  {path: '/a/b', params: [ param1 ]}
     *  , {path: '/c/d' params: [ param2 ]
     * ]
     */
    private _onRequestPacket;
    private _handleError;
    private _observableUnsubscribe;
    use<ServiceType = any>(path: string, obj: ServiceType, handler?: (obj: any, path: string) => any): void;
}
