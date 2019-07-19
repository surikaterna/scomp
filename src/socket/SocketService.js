import { EventEmitter2 } from 'eventemitter2';
export class SocketService extends EventEmitter2 {
  constructor(io) {
    super();
    this._io = io;
  }
  register(socket) {
    this.emit('connected', socket);
  }
}
