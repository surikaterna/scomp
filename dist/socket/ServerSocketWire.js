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
exports.__esModule = true;
var eventemitter2_1 = require("eventemitter2");
var WireInterface_1 = require("../WireInterface");
var SocketService_1 = require("./SocketService");
var Utils_1 = require("./Utils");
var ServerSocketWire = /** @class */ (function (_super) {
    __extends(ServerSocketWire, _super);
    function ServerSocketWire(settings) {
        var _this = _super.call(this) || this;
        // Settings
        _this.server = settings.server;
        if (settings.io) {
            _this.io = settings.io;
        }
        else {
            var io_1 = require('socket.io')();
            _this.io = io_1;
        }
        // namespace
        _this.nsp = _this.io.of('/scomp');
        _this.socketService = new SocketService_1.SocketService(_this.io);
        _this._sockets = {};
        _this.nsp.on('connection', function (socket) {
            // TODO: Do authentication before register socket.
            console.log(socket.id);
            _this.socketService.register(socket);
        });
        _this.socketService.on('connected', function (socket) {
            _this._sockets[socket.id] = socket;
            socket.on('disconnect', function () {
                console.log('disconnect!!!!!');
                delete _this._sockets[socket.id];
            });
            // Request handler
            socket.on(WireInterface_1.WireEvent.Request, function (packet) {
                var data = packet;
                data.id = socket.id + "$$" + packet.id;
                _this._handleRequestPacket(data);
            });
            // Response handler
            if (settings.bidirectional) {
                socket.on(WireInterface_1.WireEvent.Response, function (packet) { return _this._handleResponsePacket(packet); });
            }
        });
        return _this;
    }
    ServerSocketWire.prototype._handleRequestPacket = function (packet) {
        // emit 'req' event which ScompServer will handle
        this.emit(WireInterface_1.WireEvent.Request, packet);
    };
    ServerSocketWire.prototype._handleResponsePacket = function (packet) {
        // emit 'res' event' which Scomp will handle
        console.log('_handleResponsePacket', packet);
        this.emit(WireInterface_1.WireEvent.Response, packet);
    };
    ServerSocketWire.prototype.listen = function () {
        this.socketService.io.listen(this.server);
    };
    ServerSocketWire.prototype.send = function (event, packet, headers) {
        if (event === WireInterface_1.WireEvent.Request) {
            var socketId = headers ? headers.socketId : null;
            if (socketId) {
                this.io.to(socketId).emit(WireInterface_1.WireEvent.Request, packet);
            }
            else {
                this.io.of('/scomp').emit(WireInterface_1.WireEvent.Request, packet);
                // this.io.emit(SOCKET_EVENTS.Request, packet);
            }
        }
        else {
            var data = packet;
            var _a = Utils_1.getActualIds(packet), socketId = _a.socketId, packetId = _a.packetId;
            if (socketId && this._sockets[socketId] && this._sockets[socketId].connected) {
                data.id = packetId;
                this._sockets[socketId].emit(event, data);
            }
            else {
                throw Error("Socket has been disconnected " + socketId + " for packet " + packetId + ".");
            }
        }
    };
    return ServerSocketWire;
}(eventemitter2_1.EventEmitter2));
exports["default"] = ServerSocketWire;
//# sourceMappingURL=ServerSocketWire.js.map