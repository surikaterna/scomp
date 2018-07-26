import { EventEmitter } from 'events';
import { SocketService } from './SocketService';

export default class ServerSocketWire extends EventEmitter {
  constructor() {
    super();
    const io = require('socket.io')();
    this.socketService = new SocketService(io);
    this._sockets = {};

    io.on('connection', (socket) => {
      // Do authentication before register socket.
      this.socketService.register(socket);
    });
    this.socketService.on('connected', socket => {
      socket.on('req', packet => {
        const packetId = `${socket.id}/${packet.id}`;
        packet.id = packetId;
        this._sockets[packetId] = socket;
        this._handleIncomingPacket(packet);
      });
      socket.on('disconnect', () => {
        console.log('disconnect!!!!!');
      });
    });
  }

  _handleIncomingPacket(packet) {
    this.emit('req', packet);
  }

  listen(port) {
    this.socketService._io.listen(port);
  }

  _getActualPacketId(packet) {
    let packetId = packet.id;
    if (packet.id && packet.id.indexOf('/')) {
      packetId = packet.id.split('/')[1];
    }
    return packetId;
  }

  send(event, packet) {
    const id = packet.id;
    if (this._sockets[id]) {
      if (this._sockets[id].connected) {
        packet.id = this._getActualPacketId(packet);
        console.log(packet);
        this._sockets[id].emit(event, packet);
      }
    }
  }
}
