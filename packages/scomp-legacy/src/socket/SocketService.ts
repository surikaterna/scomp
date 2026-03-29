import EventEmitter from 'events';

/**
 * Minimal socket lifecycle registry used by server-side wire.
 */
export class SocketService extends EventEmitter {
  public io: any;
  public connections: any[];

  /**
   * Creates the socket service wrapper.
   */
  constructor(io: any) {
    super();
    this.io = io;
    this.connections = [];
  }
  /**
   * Registers a socket and emits a connected event.
   */
  register(socket: any, _token?: any) {
    this.connections.push(socket);
    this.emit('connected', socket);
  }
}
