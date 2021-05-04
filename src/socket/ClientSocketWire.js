import { EventEmitter } from 'events';
import io from 'socket.io-client';

export default class ClientSocketWire extends EventEmitter {
  constructor(settings) {
    super();
    const config = settings || {};

    if (config.socket) {
      this.socket = config.socket;
    } else {
      console.log(config.address + '/scomp');
      this.socket = io(config.address + '/scomp', { transports: ['websocket', 'polling', 'flashsocket'] });
    }

    this.socket.on('connect', () => {
      this.emit('connected');
      console.log(this.socket.id);
    });

    this.socket.on('disconnect', () => {
      this.emit('disconnect');
    });

    this.socket.on('res', this._handleResponsePacket.bind(this));

    if (config.bidirectional) {
      this.socket.on('req', (packet) => {
        const data = packet;
        data.id = `${this.socket.id}$$${packet.id}`;

        console.log('xxxxxxxxxxxxxxxxxxxxxx', data.id);
        this._handleRequestPacket(data);
      });
    }
  }

  _handleRequestPacket(packet) {
    console.log('Receiving request packet', packet);
    this.emit('req', packet);
  }

  _handleResponsePacket(packet) {
    this.emit('res', packet);
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

  send(event, packet) {
    const data = packet;
    if (event === 'res') {
      const { packetId } = this._getActualIds(packet);
      data.id = packetId;
    }
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    } else {
      throw new Error('Socket has been disconnected.');
    }
  }
}
