"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
exports.Scomp = void 0;
var slf_1 = require("slf");
var null_1 = __importDefault(require("./null"));
var events_1 = require("events");
var Observable_1 = __importDefault(require("./Observable"));
var PathProxyFactory_1 = __importDefault(require("./util/PathProxyFactory"));
var uuid_1 = require("uuid");
var WireInterface_1 = require("./WireInterface");
var ScompServer_1 = require("./server/ScompServer");
__createBinding(exports, ScompServer_1, "ScompServer");
var LOG = slf_1.LoggerFactory.getLogger('scomp:core');
var Scomp = /** @class */ (function (_super) {
    __extends(Scomp, _super);
    function Scomp(wire) {
        var _this = _super.call(this) || this;
        _this._requests = {};
        _this._responses = {};
        _this.wire = wire || new null_1["default"]();
        _this.wire.on('res', function (packet) {
            _this._onResponsePacket(packet);
        });
        return _this;
    }
    Scomp.prototype._onResponsePacket = function (packet) {
        var _a;
        var packetId = "" + packet.id;
        LOG.info('onPacket %d', packetId);
        if (this._requests[packetId]) {
            if (packet.sub && ((_a = packet.sub) === null || _a === void 0 ? void 0 : _a.type) === 'observable') {
                this._handleObservablePacket(packet);
            }
            else {
                if (packet.err) {
                    this._requests[packetId].reject(packet.err);
                }
                else {
                    this._requests[packetId].resolve(packet.res);
                }
                delete this._requests[packetId];
            }
        }
        else {
            throw new Error("No request handler found for " + packet.id);
        }
    };
    /**
     * Creates a new observable if not exists for packet.id
     */
    Scomp.prototype._handleObservablePacket = function (packet) {
        var _this = this;
        var _a;
        var packetId = "" + packet.id;
        if (this._requests[packetId].observable) {
            if (packet.err) {
                this._requests[packetId].observable.error(packet.err);
            }
            else {
                this._requests[packetId].observable.next(packet.res);
            }
        }
        else {
            this._requests[packetId].observable = new Observable_1["default"](function () {
            });
            this._requests[packetId].observable.controller = PathProxyFactory_1["default"]("/controller/" + ((_a = packet.sub) === null || _a === void 0 ? void 0 : _a.id), this, []);
            this._requests[packetId].observable.onUnsubscribe(function () {
                _this._unsubscribe(packet);
            });
            this._requests[packetId].resolve(this._requests[packetId].observable);
        }
    };
    Scomp.prototype._parseError = function (error) {
        return (error instanceof Error) ? JSON.stringify({ message: error.message }) : error;
    };
    Scomp.prototype._unsubscribe = function (packet) {
        var _this = this;
        var _a;
        if ((_a = packet.sub) === null || _a === void 0 ? void 0 : _a.id) {
            this.client()._server.unsubscribe({ id: packet.sub.id }).then(function () {
                delete _this._requests["" + packet.id];
            });
        }
    };
    Scomp.prototype.unsubscribe = function (id) {
        LOG.info('Unsubscribe ', id);
        if (this._responses[id]) {
            this._responses[id].unsubscribe();
            delete this._responses[id];
        }
        else {
            throw new Error("No subscription found for response " + id);
        }
    };
    Scomp.prototype.response = function (id, res, err) {
        var _this = this;
        LOG.info('Response ', id, res);
        if (res && (res instanceof Observable_1["default"]) && res.onNext) {
            // TODO remake response id, make safe
            var responseId_1 = uuid_1.v4();
            this._responses[responseId_1] = res;
            res.onNext(function (next) {
                _this.wire.send(WireInterface_1.WireEvent.Response, {
                    id: id,
                    res: next,
                    sub: { id: responseId_1, type: 'observable' }
                });
            });
            res.onError(function (error) {
                _this.wire.send(WireInterface_1.WireEvent.Response, {
                    id: id,
                    res: null,
                    err: _this._parseError(error),
                    sub: { id: responseId_1, type: 'observable' }
                });
            });
        }
        else {
            this.wire.send(WireInterface_1.WireEvent.Response, {
                id: id,
                res: res,
                err: this._parseError(err)
            });
        }
    };
    Scomp.prototype.request = function (path, params, headers) {
        var _this = this;
        var requestId = uuid_1.v4();
        return new Promise(function (resolve, reject) {
            LOG.info('Request ', path, params);
            _this._waitForResponse(requestId, resolve, reject);
            if (path instanceof Array) {
                _this.wire.send(WireInterface_1.WireEvent.Request, {
                    id: requestId,
                    paths: path,
                    params: []
                }, headers);
            }
            else {
                _this.wire.send(WireInterface_1.WireEvent.Request, {
                    id: requestId,
                    path: path,
                    params: params
                }, headers);
            }
        });
    };
    Scomp.prototype._waitForResponse = function (id, resolve, reject) {
        LOG.info('Waiting for response %d.', id);
        this._requests["" + id] = { resolve: resolve, reject: reject };
    };
    Scomp.prototype.getObservable = function (id) {
        return this._responses[id];
    };
    // on req
    // on sub
    // on res
    // on connect
    // on disconnect
    // on reconnect
    // on error
    Scomp.prototype.client = function (headers) {
        if (headers === void 0) { headers = {}; }
        // LOG.info('client builder');
        // return new Client(this, headers).path;
        return PathProxyFactory_1["default"]('', this, [], headers);
    };
    return Scomp;
}(events_1.EventEmitter));
exports.Scomp = Scomp;
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
//# sourceMappingURL=scomp.js.map