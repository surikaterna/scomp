import { EventEmitter } from 'events';
import io from 'socket.io-client';

export default class ClientSocketWire extends EventEmitter {
  constructor(settings) {
    super();
    const config = settings || {};

    this.socket = io(config.address || 'http://127.0.0.1:3001');
    
    this.socket.on('connect', () => {
      this.emit('connect');
    });

    this.socket.on('res', this._handleIncomingPacket.bind(this));
    this.socket.on('disconnect', () => {
      this.emit('disconnect');
    });
  }

  _handleIncomingPacket(packet) {
    this.emit('res', packet);
  }

  send(event, packet) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, packet);
    } else {
      throw new Error('No available socket to make request!');
    }
  }
}
