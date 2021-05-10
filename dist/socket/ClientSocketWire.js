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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
var eventemitter2_1 = require("eventemitter2");
var socket_io_client_1 = __importDefault(require("socket.io-client"));
var WireInterface_1 = require("../WireInterface");
var Utils_1 = require("./Utils");
var ClientSocketWire = /** @class */ (function (_super) {
    __extends(ClientSocketWire, _super);
    function ClientSocketWire(config) {
        var _this = _super.call(this) || this;
        if (config.socket) {
            _this.socket = config.socket;
        }
        else {
            console.log(config.address + '/scomp');
            _this.socket = socket_io_client_1["default"](config.address + '/scomp', { transports: ['websocket', 'polling', 'flashsocket'] });
        }
        _this.socket.on('connect', function () {
            _this.emit('connected');
            console.log(_this.socket.id);
        });
        _this.socket.on('disconnect', function () {
            _this.emit('disconnect');
        });
        _this.socket.on('res', _this._handleResponsePacket.bind(_this));
        if (config.bidirectional) {
            _this.socket.on('req', function (packet) {
                var data = packet;
                data.id = _this.socket.id + "$$" + packet.id;
                console.log('xxxxxxxxxxxxxxxxxxxxxx', data.id);
                _this._handleRequestPacket(data);
            });
        }
        return _this;
    }
    ClientSocketWire.prototype._handleRequestPacket = function (packet) {
        console.log('Receiving request packet', packet);
        this.emit('req', packet);
    };
    ClientSocketWire.prototype._handleResponsePacket = function (packet) {
        this.emit('res', packet);
    };
    ClientSocketWire.prototype.send = function (event, packet) {
        var data = packet;
        if (event === WireInterface_1.WireEvent.Response) {
            var packetId = Utils_1.getActualIds(packet).packetId;
            data.id = packetId;
        }
        if (this.socket && this.socket.connected) {
            this.socket.emit(event, data);
        }
        else {
            throw new Error('Socket has been disconnected.');
        }
    };
    return ClientSocketWire;
}(eventemitter2_1.EventEmitter2));
exports["default"] = ClientSocketWire;
//# sourceMappingURL=ClientSocketWire.js.map