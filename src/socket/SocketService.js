import EventEmitter from 'events';
export class SocketService extends EventEmitter {
  constructor(io) {
    super();
    this._io = io;
  }
  register(socket) {
    this.emit('connected', socket);
  }
}
