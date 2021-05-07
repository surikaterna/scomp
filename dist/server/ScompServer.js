"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
exports.__esModule = true;
exports.ScompServer = void 0;
var slf_1 = require("slf");
var sprintf_js_1 = require("sprintf-js");
var WireInterface_1 = require("../WireInterface");
var LOG = slf_1.LoggerFactory.getLogger('scomp:server');
var reflectionHandler = function (obj, path) { return obj[path]; };
var isLastIndex = function (array, index) { return array.length - 1 === index; };
var ScompServer = /** @class */ (function () {
    function ScompServer(scomp) {
        this._servicePaths = {};
        this._scomp = scomp;
        this._scomp.wire.on(WireInterface_1.WireEvent.Request, this._onRequestPacket.bind(this));
        this.use('controller', this._controllerProxy());
        this.use('_server', this._serverHandler());
    }
    ScompServer.prototype._controllerProxy = function () {
        var _this = this;
        return new Proxy(function () {
        }, {
            get: function (target, name) {
                var o = _this._scomp._getObservable(String(name));
                if (o) {
                    return o.controller;
                }
                return undefined;
            }
        });
    };
    ScompServer.prototype._serverHandler = function () {
        var _this = this;
        return {
            unsubscribe: function (packet) {
                _this._scomp.unsubscribe(packet.id);
            }
        };
    };
    /**
     * [
     *  {path: '/a/b', params: [ param1 ]}
     *  , {path: '/c/d' params: [ param2 ]
     * ]
     */
    ScompServer.prototype._onRequestPacket = function (packet) {
        var _a;
        return __awaiter(this, void 0, void 0, function () {
            var targetService, commands, i, command, paths, index, j, _b, _c, _d, err_1;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        LOG.info('Incoming request %d %j', packet.id, JSON.stringify(packet));
                        commands = (_a = packet.paths) !== null && _a !== void 0 ? _a : [];
                        if (!packet.paths && packet.path) {
                            commands = [{ path: packet.path, params: packet.params }];
                        }
                        i = 0;
                        _e.label = 1;
                    case 1:
                        if (!(i < commands.length)) return [3 /*break*/, 16];
                        command = commands[i];
                        paths = command.path.split('/').filter(function (x) { return x; });
                        if (paths.length === 0) {
                            this._handleError(packet, 'Path is empty!');
                        }
                        index = 0;
                        if (!(targetService || this._servicePaths[paths[0]])) return [3 /*break*/, 14];
                        targetService = targetService || this._servicePaths[paths[index++]].obj;
                        if (targetService === undefined || targetService === null) {
                            this._handleError(packet, 'No target found for path %s.', command.path);
                        }
                        j = index;
                        _e.label = 2;
                    case 2:
                        if (!(j < paths.length)) return [3 /*break*/, 13];
                        if (!isLastIndex(paths, j)) return [3 /*break*/, 10];
                        if (!isLastIndex(commands, i)) return [3 /*break*/, 7];
                        _e.label = 3;
                    case 3:
                        _e.trys.push([3, 5, , 6]);
                        _c = (_b = this._scomp).response;
                        _d = [packet.id];
                        return [4 /*yield*/, targetService[paths[j]].apply(targetService, command.params)];
                    case 4:
                        _c.apply(_b, _d.concat([_e.sent()]));
                        return [3 /*break*/, 13];
                    case 5:
                        err_1 = _e.sent();
                        this._scomp.response(packet.id, null, err_1);
                        return [3 /*break*/, 13];
                    case 6: return [3 /*break*/, 9];
                    case 7: return [4 /*yield*/, targetService[paths[j]].apply(targetService, command.params)];
                    case 8:
                        targetService = _e.sent();
                        _e.label = 9;
                    case 9: return [3 /*break*/, 11];
                    case 10:
                        targetService = targetService[paths[j]];
                        _e.label = 11;
                    case 11:
                        if (!targetService) {
                            this._handleError(packet, 'Target is undefined for %s on %s.', paths[j], command.path);
                        }
                        _e.label = 12;
                    case 12:
                        j++;
                        return [3 /*break*/, 2];
                    case 13: return [3 /*break*/, 15];
                    case 14:
                        this._handleError(packet, 'No binding for %s.', command.path);
                        _e.label = 15;
                    case 15:
                        i++;
                        return [3 /*break*/, 1];
                    case 16: return [2 /*return*/];
                }
            });
        });
    };
    ScompServer.prototype._handleError = function (packet, message) {
        var params = [];
        for (var _i = 2; _i < arguments.length; _i++) {
            params[_i - 2] = arguments[_i];
        }
        var m;
        try {
            m = sprintf_js_1["default"].sprintf.apply(sprintf_js_1["default"], __spreadArrays([message], params));
        }
        catch (e) {
            m = message;
        }
        var error = new Error(m);
        LOG.error.apply(LOG, __spreadArrays([message], params));
        this._scomp.response(packet.id, null, error);
        throw error;
    };
    ScompServer.prototype._observableUnsubscribe = function (packet) {
        var _a;
        if ((_a = packet.sub) === null || _a === void 0 ? void 0 : _a.id) {
            this._scomp.unsubscribe(packet.sub.id);
        }
    };
    ScompServer.prototype.use = function (path, obj, handler) {
        if (handler === void 0) { handler = reflectionHandler; }
        this._servicePaths[path] = { obj: obj, handler: handler };
    };
    return ScompServer;
}());
exports.ScompServer = ScompServer;
//# sourceMappingURL=ScompServer.js.map