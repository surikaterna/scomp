import { LoggerFactory } from 'slf';
import sprintf from 'sprintf-js';
import ControlledObservable from '../ControlledObservable';
import { Scomp, ResponsePacket, RequestPacket } from '../Scomp';
import { WireEvent } from '../WireInterface';
const LOG = LoggerFactory.getLogger('scomp:server');

const reflectionHandler = (obj: any, path: string) => obj[path];
const isLastIndex = (array: any[], index: number) => array.length - 1 === index;

export class ScompServer {
  private _scomp: Scomp;
  private _servicePaths: any;

  constructor(scomp: Scomp) {
    this._servicePaths = {};
    this._scomp = scomp;
    this._scomp.wire.on(WireEvent.Request, this._onRequestPacket.bind(this));

    this.use('controller', this._controllerProxy());
    this.use('_server', this._serverHandler());
  }

  private _controllerProxy() {
    return new Proxy(function () {
    }, {
      get: (target, name) => {
        const o = this._scomp.getObservable(String(name)) as ControlledObservable;
        if (o) {
          return o.getController();
        }
        return undefined;
      }
    });
  }

  private _serverHandler() {
    return {
      unsubscribe: (packet: ResponsePacket) => {
        this._scomp.unsubscribe(packet.id);
      }
    };
  }


  /**
   * [
   *  {path: '/a/b', params: [ param1 ]}
   *  , {path: '/c/d' params: [ param2 ]
   * ]
   */
  private async _onRequestPacket(packet: RequestPacket) {
    LOG.info('Incoming request %d %j', packet.id, JSON.stringify(packet));
    let targetService;
    let commands = packet.paths ?? [];
    if (!packet.paths && packet.path) {
      commands = [{ path: packet.path, params: packet.params ?? [] }];
    }
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const paths = command.path.split('/').filter(x => x);
      if (paths.length === 0) {
        this._handleError(packet, 'Path is empty!');
      }
      let index = 0;
      if (targetService || this._servicePaths[paths[0]]) {
        targetService = targetService || this._servicePaths[paths[index++]].obj;
        if (targetService === undefined || targetService === null) {
          this._handleError(packet, 'No target found for path %s.', command.path);
        }
        for (let j = index; j < paths.length; j++) {
          if (isLastIndex(paths, j)) {
            if (isLastIndex(commands, i)) {
              try {
                this._scomp.response(packet.id, await targetService[paths[j]](...command.params));
                break;
              } catch (err) {
                this._scomp.response(packet.id, null, err);
                break;
              }
            } else {
              targetService = await targetService[paths[j]](...command.params);
            }
          } else {
            targetService = targetService[paths[j]];
          }
          if (!targetService) {
            this._handleError(packet, 'Target is undefined for %s on %s.', paths[j], command.path);
          }
        }
      } else {
        this._handleError(packet, 'No binding for %s.', command.path);
      }
    }
  }

  private _handleError(packet: RequestPacket, message: string, ...params: any[]) {
    let m;
    try {
      m = sprintf.sprintf(message, ...params);
    } catch (e) {
      m = message;
    }
    const error = new Error(m);
    LOG.error(message, ...params);
    this._scomp.response(packet.id, null, error);
    return error;
  }

  private _observableUnsubscribe(packet: ResponsePacket) {
    if (packet.sub?.id) {
      this._scomp.unsubscribe(packet.sub.id);
    }
  }

  use<ServiceType = any>(path: string, obj: ServiceType, handler = reflectionHandler) {
    this._servicePaths[path] = { obj, handler };
  }
}
