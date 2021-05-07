import { LoggerFactory } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Observable from './Observable';
import pathProxyFactory, { Path } from './util/PathProxyFactory';
import { v4 as uuidv4 } from 'uuid';
import WireInterface, { WireEvent } from './WireInterface';

export { ScompServer } from './server/ScompServer';
const LOG = LoggerFactory.getLogger('scomp:core');

export interface ScompHeader {
  socketId?: string;
}

export interface RequestPacket {
  id: string;
  paths?: Path[]
  path?: string;
  params: Array<any>
}

export interface ResponsePacket<T = any> {
  id: string;
  res: T;
  sub?: {
    id: string;
    type: 'observable'
  },
  err?: Error | string;
}

interface ScompRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  observable?: Observable;
}

export class Scomp extends EventEmitter {
  private _requests: Record<string, ScompRequest>;
  private _responses: Record<string, Observable>;
  
  public wire: WireInterface;

  constructor(wire: WireInterface) {
    super();
    this._requests = {};
    this._responses = {};
    this.wire = wire || new NullWire();
    this.wire.on('res', (packet) => {
      this._onResponsePacket(packet);
    });
  }

  _onResponsePacket(packet: ResponsePacket) {
    const packetId = `${packet.id}`;
    LOG.info('onPacket %d', packetId);
    if (this._requests[packetId]) {
      if (packet.sub && packet.sub?.type === 'observable') {
        this._handleObservablePacket(packet);
      } else {
        if (packet.err) {
          this._requests[packetId].reject(packet.err);
        } else {
          this._requests[packetId].resolve(packet.res);
        }
        delete this._requests[packetId];
      }
    } else {
      throw new Error(`No request handler found for ${packet.id}`);
    }
  }

  /**
   * Creates a new observable if not exists for packet.id
   */
  _handleObservablePacket(packet: ResponsePacket) {
    const packetId = `${packet.id}`;
    if (this._requests[packetId].observable) {
      if (packet.err) {
        this._requests[packetId].observable!.error(packet.err);
      } else {
        this._requests[packetId].observable!.next(packet.res);
      }
    } else {
      this._requests[packetId].observable = new Observable(() => {
      });
      this._requests[packetId].observable!.controller = pathProxyFactory(`/controller/${packet.sub?.id}`, this, []);

      this._requests[packetId].observable!.onUnsubscribe(() => {
        this._unsubscribe(packet);
      });
      this._requests[packetId].resolve(this._requests[packetId].observable);
    }
  }

  _parseError(error?: Error | string) {
    return (error instanceof Error) ? JSON.stringify({ message: error.message }) : error;
  }

  _unsubscribe(packet: ResponsePacket) {
    if (packet.sub?.id) {
      this.client()._server.unsubscribe({ id: packet.sub.id }).then(() => {
        delete this._requests[`${packet.id}`];
      });
    }
  }

  unsubscribe(id: string) {
    LOG.info('Unsubscribe ', id);
    if (this._responses[id]) {
      this._responses[id].unsubscribe();
      delete this._responses[id];
    } else {
      throw new Error(`No subscription found for response ${id}`);
    }
  }

  response(id: string, res: any | Observable, err?: Error) {
    LOG.info('Response ', id, res);
    if (res && (res instanceof Observable) && res.onNext) {
      // TODO remake response id, make safe
      const responseId = uuidv4();
      this._responses[responseId] = res;
      res.onNext((next) => {
        this.wire.send(WireEvent.Response, {
          id,
          res: next,
          sub: { id: responseId, type: 'observable' }
        });
      });
      res.onError((error: any) => {
        this.wire.send(WireEvent.Response, {
          id,
          res: null,
          err: this._parseError(error),
          sub: { id: responseId, type: 'observable' }
        });
      });
    } else {
      this.wire.send(WireEvent.Response, {
        id,
        res,
        err: this._parseError(err)
      });
    }
  }

  request(path: string | Path[], params: any, headers: ScompHeader) {
    const requestId = uuidv4();
    return new Promise((resolve, reject) => {
      LOG.info('Request ', path, params);
      this._waitForResponse(requestId, resolve, reject);
      if (path instanceof Array) {
        this.wire.send<RequestPacket>(WireEvent.Request, {
          id: requestId,
          paths: path,
          params: []
        }, headers);
      } else {
        this.wire.send<RequestPacket>(WireEvent.Request, {
          id: requestId,
          path,
          params
        }, headers);
      }
    });
  }

  _waitForResponse(id: string, resolve: (data?: any) => void, reject: (error: any) => void) {
    LOG.info('Waiting for response %d.', id);
    this._requests[`${id}`] = { resolve, reject };
  }

  _getObservable(id: string) {
    return this._responses[id];
  }

  // on req
  // on sub
  // on res
  // on connect
  // on disconnect
  // on reconnect
  // on error

  client<ServerApiInterface = any>(headers: ScompHeader = {}) {
    // LOG.info('client builder');
    // return new Client(this, headers).path;
    return pathProxyFactory('', this, [], headers) as ServerApiInterface;
  }

}

// export class Client {
//   private scomp: Scomp;
//   private headers?: ScompHeader;
//   public path: any;
//   constructor(scomp: Scomp, headers: ScompHeader) {
//     this.scomp = scomp;
//     this.headers = headers;
//     this.path = pathProxyFactory('', this.scomp, [], this.headers);
//   }

//   build() {
//     return 
//   }

//   // service(serviceType: keyof ServerApiInterface) {

//   // }

//   then() {
    
//   }
// }


// scomp.client().