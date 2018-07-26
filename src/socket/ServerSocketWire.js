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
      this._sockets[socket.id] = socket;

      socket.on('req', packet => {
        const data = packet;
        // We need to store the socket id for the request to be abel
        // to respond to the correct socket.
        data.id = `${socket.id}/${packet.id}`;
        this._handleIncomingPacket(data);
      });
      socket.on('disconnect', () => {
        console.log('disconnect!!!!!');
        delete this._sockets[socket.id];
      });
    });
  }

  _handleIncomingPacket(packet) {
    this.emit('req', packet);
  }

  listen(port) {
    this.socketService._io.listen(port);
  }

  _getActualIds(packet) {
    let packetId = packet.id;
    let socketId;
    if (packet.id && packet.id.indexOf('/')) {
      const splittedKeys = packet.id.split('/');
      socketId = splittedKeys[0];
      packetId = splittedKeys[1];
    }
    return { socketId, packetId };
  }

  send(event, packet) {
    const data = packet;
    const { socketId, packetId } = this._getActualIds(packet);
    if (this._sockets[socketId]) {
      if (this._sockets[socketId].connected) {
        data.id = packetId;
        console.log(packet);
        this._sockets[socketId].emit(event, data);
      }
    }
  }
}
