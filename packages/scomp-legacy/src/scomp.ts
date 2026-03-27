import { LoggerFactory } from 'slf';
import NullWire from './null';
import { EventEmitter } from 'events';
import Observable from './Observable';
import pathProxyFactory, { Path } from './util/PathProxyFactory';
import { v4 as uuidv4 } from 'uuid';
import { WireEvent, WireInterface } from './WireInterface';

export { ScompServer } from './server/ScompServer';
const LOG = LoggerFactory.getLogger('scomp:core');

export interface ScompHeader {
  socketId?: string;
}

export interface RequestPacket {
  id: string;
  paths?: Path[]
  path?: string;
  params?: Array<any>
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

interface SubscriptionHandle {
  unsubscribe: () => unknown;
}

interface ObservableLike {
  onNext: (fn: (res: any) => void) => ObservableLike;
  onError?: (fn: (err: any) => void) => ObservableLike;
  onComplete?: (fn: (res: any) => void) => ObservableLike;
  unsubscribe?: () => unknown;
}

type StreamResponse =
  | ObservableLike
  | AsyncIterable<any>
  | Iterable<any>;

type StoredResponse = ObservableLike | SubscriptionHandle;

export class Scomp extends EventEmitter {
  private _requests: Record<string, ScompRequest>;
  private _responses: Record<string, StoredResponse>;
  private _onAuthenticate?: Function;
  
  public wire: WireInterface;

  constructor(wire: WireInterface) {
    super();
    this._requests = {};
    this._responses = {};
    this.wire = wire || new NullWire();
    this.wire.on(WireEvent.Response, (packet) => {
      try {
        this._onResponsePacket(packet);
      } catch (e) {
        console.log(e.message);
        // package error;
      }
    });
    this.wire.on(WireEvent.Connected, (data) => {
      console.log('*** Received connected event', data?.socket?.id);
    });
    this.wire.on(WireEvent.Authenticated, (data) => {
      this._onAuthenticate?.();
    });
  }

  private _onResponsePacket(packet: ResponsePacket) {
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
      // TODO: Do something here ...
      throw new Error(`No request handler found for ${packet.id}`);
    }
  }

  /**
   * Creates a new observable if not exists for packet.id
   */
  private _handleObservablePacket(packet: ResponsePacket) {
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

  private _parseError(error?: Error | string) {
    return (error instanceof Error) ? JSON.stringify({ message: error.message }) : error;
  }

  private _unsubscribe(packet: ResponsePacket) {
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

  response(id: string, res: any | StreamResponse, err?: Error) {
    LOG.info('Response ', id, res);
    if (this._isObservableLike(res)) {
      this._responseObservableLike(id, res);
    } else if (this._isIterableLike(res)) {
      this._responseIterable(id, res);
    } else {
      this.wire.send(WireEvent.Response, {
        id,
        res,
        err: this._parseError(err)
      });
    }
  }

  private _isObservableLike(res: any): res is ObservableLike {
    return !!res && typeof res.onNext === 'function';
  }

  private _isIterableLike(res: any): res is AsyncIterable<any> | Iterable<any> {
    return !!res
      && (typeof res[Symbol.asyncIterator] === 'function' || typeof res[Symbol.iterator] === 'function');
  }

  private _responseObservableLike(id: string, res: ObservableLike) {
    const responseId = uuidv4();
    this._responses[responseId] = res;

    res.onNext((next: any) => {
      this.wire.send(WireEvent.Response, {
        id,
        res: next,
        sub: { id: responseId, type: 'observable' }
      });
    });

    res.onError?.((error: any) => {
      this.wire.send(WireEvent.Response, {
        id,
        res: null,
        err: this._parseError(error),
        sub: { id: responseId, type: 'observable' }
      });
    });
  }

  private _responseIterable(id: string, res: AsyncIterable<any> | Iterable<any>) {
    const responseId = uuidv4();
    let isUnsubscribed = false;

    this._responses[responseId] = {
      unsubscribe: () => {
        isUnsubscribed = true;
      }
    };

    void (async () => {
      try {
        for await (const next of res) {
          if (isUnsubscribed) {
            break;
          }
          this.wire.send(WireEvent.Response, {
            id,
            res: next,
            sub: { id: responseId, type: 'observable' }
          });
        }
      } catch (error) {
        this.wire.send(WireEvent.Response, {
          id,
          res: null,
          err: this._parseError(error as Error),
          sub: { id: responseId, type: 'observable' }
        });
      }
    })();
  }

  request(path: string | Path[], params: any, headers: ScompHeader) {
    const requestId = uuidv4();
    return new Promise((resolve, reject) => {
      LOG.info('Request ', path, params);
      this._waitForResponse(requestId, resolve, reject);
      if (path instanceof Array) {
        this.wire.send<RequestPacket>(WireEvent.Request, {
          id: requestId,
          paths: path
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

  private _waitForResponse(id: string, resolve: (data?: any) => void, reject: (error: any) => void) {
    LOG.info('Waiting for response %d.', id);
    this._requests[`${id}`] = { resolve, reject };
  }

  getObservable(id: string) {
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
    LOG.info('client builder');
    return pathProxyFactory('', this, [], headers) as ServerApiInterface;
  }

  // TODO: 
  // client can be broadcast or send to specific ... so broadcast we omit

  getConnections() {
    return this.wire.getConnections();
  }

  onAuthenticate(callback: Function) {
    this._onAuthenticate = callback;
  }

  onConnection() {

  }
}
