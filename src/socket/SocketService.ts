import EventEmitter from 'events';
export class SocketService extends EventEmitter {
  public io: any;

  constructor(io: any) {
    super();
    this.io = io;
  }
  register(socket: any) {
    this.emit('connected', socket);
  }
}
