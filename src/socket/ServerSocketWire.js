import EventEmitter from 'events';
import { SocketService } from './SocketService';

const SOCKET_EVENTS = {
  Request: 'req',
  Response: 'res'
}

const WIRE_EVENTS = {
  Request: 'req',
  Response: 'res'
}

export default class ServerSocketWire extends EventEmitter {
  constructor(settings) {
    super();
    
    // Settings
    this.server = settings.server;
    this.bidirectional = settings.bidirectional || true;

    if (settings.io) {
      this.io = settings.io;
    } else {
      const io = require('socket.io')();
      this.io = io;
    }

    // namespace
    this.nsp = this.io.of('/scomp');

    this.socketService = new SocketService(this.io);
    this._sockets = {};

    this.nsp.on('connection', (socket) => {
      // TODO: Do authentication before register socket.
      console.log(socket.id);
      this.socketService.register(socket);
    });

    this.socketService.on('connected', socket => {
      this._sockets[socket.id] = socket;

      socket.on('disconnect', () => {
        console.log('disconnect!!!!!');
        delete this._sockets[socket.id];
      });

      // Request handler
      socket.on(SOCKET_EVENTS.Request, packet => {
        const data = packet;
        data.id = `${socket.id}$$${packet.id}`;
        this._handleRequestPacket(data);
      });

      // Response handler
      if (this.bidirectional) {
        socket.on(SOCKET_EVENTS.Response, (packet) =>  this._handleResponsePacket(packet));
      }
    });
  }

  _handleRequestPacket(packet) {
    // emit 'req' event which ScompServer will handle
    this.emit(WIRE_EVENTS.Request, packet);
  }

  _handleResponsePacket(packet) {
    // emit 'res' event' which Scomp will handle
    console.log('_handleResponsePacket', packet);
    this.emit(WIRE_EVENTS.Response, packet);
  }

  listen() {
    this.socketService._io.listen(this.server);
  }

  _getActualIds(packet) {
    let packetId = packet.id;
    let socketId;
    if (packet.id && packet.id.indexOf('$$')) {
      const splittedKeys = packet.id.split('$$');
      socketId = splittedKeys[0];
      packetId = splittedKeys[1];
    }
    return { socketId, packetId };
  }

  send(event, packet, headers) {
    if (event === 'req') {
      const socketId = headers ? headers.socketId : null;
      if (socketId) {
        this.io.to(socketId).emit(SOCKET_EVENTS.Request, packet);
      } else {
        this.io.of('/scomp').emit(SOCKET_EVENTS.Request, packet);
        // this.io.emit(SOCKET_EVENTS.Request, packet);
      }
    } else {
      const data = packet;
      const { socketId, packetId } = this._getActualIds(packet);
      if (this._sockets[socketId] && this._sockets[socketId].connected) {
        data.id = packetId;
        this._sockets[socketId].emit(event, data);
      } else {
        throw Error(`Socket has been disconnected ${socketId} for packet ${packetId}.`);
      }
    }
  }
}
