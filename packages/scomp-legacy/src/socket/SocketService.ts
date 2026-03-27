import EventEmitter from 'events';

/**
 * Minimal socket lifecycle registry used by server-side wire.
 */
export class SocketService extends EventEmitter {
  public io: any;

  /**
   * Creates the socket service wrapper.
   */
  constructor(io: any) {
    super();
    this.io = io;
  }
  /**
   * Registers a socket and emits a connected event.
   */
  register(socket: any) {
    this.emit('connected', socket);
  }
}
