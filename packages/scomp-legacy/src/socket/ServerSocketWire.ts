import { EventEmitter2 } from 'eventemitter2';
import socketioJwt from 'socketio-jwt';
import { RequestPacket, ResponsePacket, ScompHeader } from '../scomp';
import WireInterface, { WireEvent } from '../WireInterface';
import { SocketService } from './SocketService';
import { getActualIds } from './Utils';

/**
 * Configuration for creating a server-side socket wire.
 */
export interface ServerSocketWireConfig {
  server?: any;
  io?: any;
  bidirectional: boolean;
  authentication?: {
    secret: string,
    timeout?: number
  }
}

type Socket = any;

/**
 * Socket.IO based server transport for legacy scomp runtime.
 */
export default class ServerSocketWire extends EventEmitter2 implements WireInterface {
  private io: any;
  private server: any;
  private nsp: any;
  private socketService: SocketService;
  private _sockets: Record<string, Socket>;

  /**
   * Creates a server wire and binds namespace-level socket listeners.
   */
  constructor(settings: ServerSocketWireConfig) {
    super();
    
    // Settings
    this.server = settings.server;

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

    if (settings.authentication) {
      this.nsp.on('connection', socketioJwt.authorize({
        secret: settings.authentication.secret
      })).on('authenticated', (socket: Socket) => {
        console.log(socket.decoded_token);
        this.socketService.register(socket, socket.decoded_token);
      });
    } else {
      this.nsp.on('connection', (socket: Socket) => {
        // TODO: Do authentication before register socket.
        console.log(socket.id);
        this.socketService.register(socket);
      });
    }

    this.socketService.on('connected', socket => {
      this._sockets[socket.id] = socket;

      socket.on('disconnect', () => {
        console.log('disconnect!!!!!');
        delete this._sockets[socket.id];
      });

      // Request handler
      socket.on(WireEvent.Request, (packet: RequestPacket) => {
        const data = packet;
        data.id = `${socket.id}$$${packet.id}`;
        this._handleRequestPacket(data);
      });

      // Response handler
      if (settings.bidirectional) {
        socket.on(WireEvent.Response, (packet: ResponsePacket) =>  this._handleResponsePacket(packet));
      }

      this.emit(WireEvent.Connected, { socket });
    });
  }

  /** Handles inbound request packets from connected clients. */
  _handleRequestPacket(packet: RequestPacket) {
    // emit 'req' event which ScompServer will handle
    this.emit(WireEvent.Request, packet);
  }

  /** Handles inbound response packets in bidirectional mode. */
  _handleResponsePacket(packet: ResponsePacket) {
    // emit 'res' event' which Scomp will handle
    console.log('_handleResponsePacket', packet);
    this.emit(WireEvent.Response, packet);
  }

  /** Starts listening on the configured HTTP server. */
  listen() {
    this.socketService.io.listen(this.server);
  }

  /** @inheritdoc */
  send(event: WireEvent, packet: ResponsePacket | RequestPacket, headers: ScompHeader) {
    if (event === WireEvent.Request) {
      const socketId = headers ? headers.socketId : null;
      if (socketId) {
        console.log('**** emit to this socketId ???', socketId);
        this.io.of('/scomp').to(socketId).emit(WireEvent.Request, packet);
      } else {
        this.io.of('/scomp').emit(WireEvent.Request, packet);
        // this.io.emit(SOCKET_EVENTS.Request, packet);
      }
    } else {
      const data = packet;
      const { socketId, packetId } = getActualIds(packet);
      if (socketId && this._sockets[socketId] && this._sockets[socketId].connected) {
        data.id = packetId;
        this._sockets[socketId].emit(event, data);
      } else {
        throw Error(`Socket has been disconnected ${socketId} for packet ${packetId}.`);
      }
    }
  }

  /** @inheritdoc */
  getConnections() {
    return this.socketService.connections;
  }
}
